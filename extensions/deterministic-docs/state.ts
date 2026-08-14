import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  DocsCandidate,
  DeterministicDocsStateEntry,
  DeterministicDocsStateSnapshot,
  ReservationSnapshot,
  ReservationTransactionOutcome,
} from "./types";

export const DETERMINISTIC_DOCS_STATE_TYPE = "deterministic-docs-state";

interface ReservationRecord extends ReservationSnapshot {
  completion: Promise<ReservationTransactionOutcome>;
  resolveCompletion(outcome: ReservationTransactionOutcome): void;
}

export type ReservationAcquisition = "owned" | "skipped";
export type ReservationAttempt = "owned" | "blocked";

export function observationKey(path: string, hash: string): string {
  return `${path}\0${hash}`;
}

function isStateEntry(value: unknown): value is DeterministicDocsStateEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<DeterministicDocsStateEntry>;
  return (
    typeof entry.path === "string" &&
    typeof entry.hash === "string" &&
    typeof entry.loadedAt === "string" &&
    typeof entry.triggerPath === "string"
  );
}

export function mergeSeenCandidates(
  state: DeterministicDocsStateSnapshot,
  candidates: Iterable<DocsCandidate>,
): void {
  for (const candidate of candidates) {
    state.seenIdentities.add(observationKey(candidate.path, candidate.hash));
  }
}

export function restoreDeterministicDocsState(
  ctx: Pick<ExtensionContext, "sessionManager">,
  startupSeen: Iterable<DocsCandidate> = [],
): DeterministicDocsStateSnapshot {
  const state: DeterministicDocsStateSnapshot = {
    seenIdentities: new Set<string>(),
  };

  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type === "custom" &&
      entry.customType === DETERMINISTIC_DOCS_STATE_TYPE &&
      isStateEntry(entry.data)
    ) {
      state.seenIdentities.add(observationKey(entry.data.path, entry.data.hash));
    }
  }

  mergeSeenCandidates(state, startupSeen);
  return state;
}

export function shouldReadDocsFile(
  state: DeterministicDocsStateSnapshot,
  candidate: DocsCandidate,
): boolean {
  return !state.seenIdentities.has(observationKey(candidate.path, candidate.hash));
}

export function commitDocsFiles(
  state: DeterministicDocsStateSnapshot,
  entries: DeterministicDocsStateEntry[],
  appendEntry: (customType: string, data?: unknown) => void,
): DeterministicDocsStateEntry[] {
  const committed: DeterministicDocsStateEntry[] = [];

  for (const entry of entries) {
    const key = observationKey(entry.path, entry.hash);
    if (state.seenIdentities.has(key)) continue;

    appendEntry(DETERMINISTIC_DOCS_STATE_TYPE, entry);
    state.seenIdentities.add(key);
    committed.push(entry);
  }

  return committed;
}

async function waitForReservation(
  completion: Promise<ReservationTransactionOutcome>,
  signal?: AbortSignal,
): Promise<ReservationTransactionOutcome> {
  if (!signal) return completion;
  if (signal.aborted) throw new Error("Operation aborted");

  return new Promise<ReservationTransactionOutcome>((resolve, reject) => {
    const onAbort = () => reject(new Error("Operation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    completion.then(
      (outcome) => {
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class ReservationCoordinator {
  private readonly reservations = new Map<string, ReservationRecord>();
  private readonly history = new Map<string, ReservationSnapshot>();

  tryReserve(
    candidate: DocsCandidate,
    ownerToolCallId: string,
  ): ReservationAttempt {
    const key = observationKey(candidate.path, candidate.hash);
    const current = this.reservations.get(key);
    if (current) {
      return current.ownerToolCallId === ownerToolCallId ? "owned" : "blocked";
    }

    let resolveCompletion = (_outcome: ReservationTransactionOutcome) => {};
    const completion = new Promise<ReservationTransactionOutcome>((resolve) => {
      resolveCompletion = resolve;
    });
    this.reservations.set(key, {
      ...candidate,
      ownerToolCallId,
      loadOutcome: "pending",
      transactionOutcome: "pending",
      completion,
      resolveCompletion,
    });
    return "owned";
  }

  async acquire(
    candidate: DocsCandidate,
    ownerToolCallId: string,
    isSeen: () => boolean,
    signal?: AbortSignal,
  ): Promise<ReservationAcquisition> {
    const key = observationKey(candidate.path, candidate.hash);

    while (!isSeen()) {
      const current = this.reservations.get(key);
      if (!current) {
        this.tryReserve(candidate, ownerToolCallId);
        return "owned";
      }
      if (current.ownerToolCallId === ownerToolCallId) return "owned";

      const outcome = await waitForReservation(current.completion, signal);
      if (outcome === "committed") return "skipped";
    }

    return "skipped";
  }

  markLoadSucceeded(key: string, ownerToolCallId: string): void {
    const reservation = this.reservations.get(key);
    if (reservation?.ownerToolCallId === ownerToolCallId) {
      reservation.loadOutcome = "succeeded";
    }
  }

  markLoadFailed(key: string, ownerToolCallId: string): void {
    const reservation = this.reservations.get(key);
    if (reservation?.ownerToolCallId === ownerToolCallId) {
      reservation.loadOutcome = "failed";
    }
  }

  finalize(
    keys: Iterable<string>,
    ownerToolCallId: string,
    outcome: Exclude<ReservationTransactionOutcome, "pending">,
  ): void {
    for (const key of keys) {
      const reservation = this.reservations.get(key);
      if (!reservation || reservation.ownerToolCallId !== ownerToolCallId) {
        continue;
      }

      reservation.transactionOutcome = outcome;
      this.history.set(key, {
        path: reservation.path,
        hash: reservation.hash,
        ownerToolCallId: reservation.ownerToolCallId,
        loadOutcome: reservation.loadOutcome,
        transactionOutcome: reservation.transactionOutcome,
      });
      this.reservations.delete(key);
      reservation.resolveCompletion(outcome);
    }
  }

  snapshot(key: string): ReservationSnapshot | undefined {
    const reservation = this.reservations.get(key);
    if (reservation) {
      return {
        path: reservation.path,
        hash: reservation.hash,
        ownerToolCallId: reservation.ownerToolCallId,
        loadOutcome: reservation.loadOutcome,
        transactionOutcome: reservation.transactionOutcome,
      };
    }
    return this.history.get(key);
  }
}
