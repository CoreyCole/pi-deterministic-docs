import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { DocsCandidate, DeterministicDocsStateEntry, DeterministicDocsStateSnapshot } from "./types";

export const DETERMINISTIC_DOCS_STATE_TYPE = "deterministic-docs-state";

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

export function restoreDeterministicDocsState(ctx: ExtensionContext): DeterministicDocsStateSnapshot {
  const byPath = new Map<string, DeterministicDocsStateEntry>();

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== DETERMINISTIC_DOCS_STATE_TYPE) continue;
    if (isStateEntry(entry.data)) byPath.set(entry.data.path, entry.data);
  }

  return { byPath };
}

export function shouldReadDocsFile(state: DeterministicDocsStateSnapshot, candidate: DocsCandidate): boolean {
  return state.byPath.get(candidate.path)?.hash !== candidate.hash;
}

export function rememberDocsFile(
  state: DeterministicDocsStateSnapshot,
  entry: DeterministicDocsStateEntry,
  appendEntry: (customType: string, data?: unknown) => void,
) {
  state.byPath.set(entry.path, entry);
  appendEntry(DETERMINISTIC_DOCS_STATE_TYPE, entry);
}
