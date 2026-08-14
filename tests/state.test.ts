import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  commitDocsFiles,
  DETERMINISTIC_DOCS_STATE_TYPE,
  mergeSeenCandidates,
  restoreDeterministicDocsState,
  shouldReadDocsFile,
} from "../extensions/deterministic-docs/state";
import type { DeterministicDocsStateEntry } from "../extensions/deterministic-docs/types";

function observation(path: string, hash: string): DeterministicDocsStateEntry {
  return {
    path,
    hash,
    loadedAt: "2026-08-14T00:00:00.000Z",
    triggerPath: "/project/target.ts",
  };
}

describe("active branch state", () => {
  it("reconstructs observations only from the selected branch", () => {
    const sessionManager = SessionManager.inMemory("/project");
    const beforeObservation = sessionManager.appendCustomEntry("marker");
    const entry = observation("/project/AGENTS.md", "hash-a");
    const observationId = sessionManager.appendCustomEntry(
      DETERMINISTIC_DOCS_STATE_TYPE,
      entry,
    );

    sessionManager.branch(beforeObservation);
    const before = restoreDeterministicDocsState({ sessionManager });
    expect(shouldReadDocsFile(before, entry)).toBe(true);

    sessionManager.branch(observationId);
    const after = restoreDeterministicDocsState({ sessionManager });
    expect(shouldReadDocsFile(after, entry)).toBe(false);
  });

  it("keeps startup observations separate from custom entries", () => {
    const sessionManager = SessionManager.inMemory("/project");
    const startup = { path: "/project/AGENTS.md", hash: "startup-hash" };

    const state = restoreDeterministicDocsState({ sessionManager }, [startup]);

    expect(shouldReadDocsFile(state, startup)).toBe(false);
    expect(sessionManager.getEntries()).toEqual([]);
  });

  it("merges startup observations after branch reconstruction", () => {
    const sessionManager = SessionManager.inMemory("/project");
    const startup = { path: "/project/AGENTS.md", hash: "startup-hash" };
    const state = restoreDeterministicDocsState({ sessionManager });

    mergeSeenCandidates(state, [startup]);

    expect(shouldReadDocsFile(state, startup)).toBe(false);
  });

  it("tracks each canonical path and content hash independently", () => {
    const state = { seenIdentities: new Set<string>() };
    const appendEntry = vi.fn();
    const first = observation("/project/AGENTS.md", "hash-a");
    const changed = observation("/project/AGENTS.md", "hash-b");

    commitDocsFiles(state, [first], appendEntry);

    expect(shouldReadDocsFile(state, first)).toBe(false);
    expect(shouldReadDocsFile(state, changed)).toBe(true);
  });

  it("centralizes append and memory mutation without duplicates", () => {
    const state = { seenIdentities: new Set<string>() };
    const appendEntry = vi.fn();
    const entry = observation("/project/AGENTS.md", "hash-a");

    const first = commitDocsFiles(state, [entry, entry], appendEntry);
    const second = commitDocsFiles(state, [entry], appendEntry);

    expect(first).toEqual([entry]);
    expect(second).toEqual([]);
    expect(appendEntry).toHaveBeenCalledOnce();
    expect(appendEntry).toHaveBeenCalledWith(
      DETERMINISTIC_DOCS_STATE_TYPE,
      entry,
    );
  });
});
