export interface DeterministicDocsStateEntry {
  path: string;
  hash: string;
  loadedAt: string;
  triggerPath: string;
}

export interface DeterministicDocsStateSnapshot {
  seenIdentities: Set<string>;
}

export interface ResolvedReadTarget {
  requestedPath: string;
  canonicalCwd: string;
  canonicalPath: string;
}

export interface DocsCandidate {
  path: string;
  hash: string;
}

export type ReservationLoadOutcome = "pending" | "succeeded" | "failed";
export type ReservationTransactionOutcome =
  | "pending"
  | "committed"
  | "rolled-back";

export interface ReservationSnapshot extends DocsCandidate {
  ownerToolCallId: string;
  loadOutcome: ReservationLoadOutcome;
  transactionOutcome: ReservationTransactionOutcome;
}

export interface DeterministicDocsReadDetails {
  deterministicDocs?: {
    loaded: DeterministicDocsStateEntry[];
    skipped: string[];
    autoContextContentBlocks: number;
  };
}
