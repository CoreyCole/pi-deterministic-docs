export interface DeterministicDocsStateEntry {
  path: string;
  hash: string;
  loadedAt: string;
  triggerPath: string;
}

export interface DeterministicDocsStateSnapshot {
  byPath: Map<string, DeterministicDocsStateEntry>;
}

export interface ResolvedReadTarget {
  requestedPath: string;
  absolutePath: string;
}

export interface DocsCandidate {
  path: string;
  hash: string;
}

export interface DeterministicDocsReadDetails {
  deterministicDocs?: {
    loaded: DeterministicDocsStateEntry[];
    skipped: string[];
    autoContextContentBlocks: number;
  };
}
