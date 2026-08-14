import type {
  ExtensionAPI,
  ExtensionContext,
  ReadToolDetails,
} from "@earendil-works/pi-coding-agent";
import {
  createReadToolDefinition,
  isReadToolResult,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { hashDocContent, hashDocFile } from "./hash";
import {
  canonicalizeExistingFile,
  findAncestorDocsFiles,
  isInstructionFilePath,
  resolveReadTarget,
} from "./paths";
import {
  commitDocsFiles,
  mergeSeenCandidates,
  observationKey,
  ReservationCoordinator,
  restoreDeterministicDocsState,
  shouldReadDocsFile,
} from "./state";
import type {
  DeterministicDocsReadDetails,
  DeterministicDocsStateEntry,
  DocsCandidate,
  ResolvedReadTarget,
} from "./types";

type ReadContent = TextContent | ImageContent;
export type ReadResult = {
  content: ReadContent[];
  details: (ReadToolDetails & DeterministicDocsReadDetails) | undefined;
};

export type AutoLoadedDocsRead = {
  entry: DeterministicDocsStateEntry;
  result: ReadResult;
};

type ExplicitPreflight = {
  target: ResolvedReadTarget;
  candidates: DocsCandidate[];
  reservedKeys: Set<string>;
};

type LoadInstruction = (
  path: string,
  toolCallId: string,
  ctx: ExtensionContext,
) => Promise<ReadResult>;

export interface DeterministicDocsRuntimeOptions {
  loadInstruction?: LoadInstruction;
}

class ContextLoadError extends Error {
  readonly contextPath: string;

  constructor(contextPath: string) {
    super(`Cannot load required instruction file: ${contextPath}`);
    this.contextPath = contextPath;
  }
}

function textContent(text: string): TextContent {
  return { type: "text", text };
}

function textBlocks(result: ReadResult): string[] {
  return result.content.flatMap((content) =>
    content.type === "text" ? [content.text] : [],
  );
}

function formatLoadedDocsSection(
  autoLoaded: AutoLoadedDocsRead[],
): string | undefined {
  if (autoLoaded.length === 0) return undefined;

  const sections = autoLoaded.map(({ entry, result }) => {
    const body = textBlocks(result).join("\n").trimEnd();
    return [
      `## Auto-loaded context: ${entry.path}`,
      body || "[context file produced no text content]",
    ].join("\n");
  });

  return ["# Deterministic docs context", ...sections].join("\n\n");
}

export function composeReadResult(args: {
  autoLoaded: AutoLoadedDocsRead[];
  skipped: string[];
  targetResult: ReadResult;
}): ReadResult {
  const loaded = args.autoLoaded.map(({ entry }) => entry);
  if (loaded.length === 0) return args.targetResult;

  const loadedSection = formatLoadedDocsSection(args.autoLoaded);
  const prefix = [loadedSection].filter((part): part is string =>
    Boolean(part),
  );
  const content = [
    ...prefix.map(textContent),
    ...args.targetResult.content,
  ];

  return {
    ...args.targetResult,
    content,
    details: {
      ...(args.targetResult.details ?? {}),
      deterministicDocs: {
        loaded,
        skipped: args.skipped,
        autoContextContentBlocks: prefix.length,
      },
    },
  };
}

function failedContextResult(
  targetResult: ReadResult,
  contextPath: string,
): ReadResult & { isError: true } {
  return {
    content: [textContent(`Cannot load required instruction file: ${contextPath}`)],
    details: {
      ...(targetResult.details ?? {}),
      deterministicDocs: {
        loaded: [],
        skipped: [],
        autoContextContentBlocks: 0,
      },
    },
    isError: true,
  };
}

function isCompleteRead(params: { offset?: number; limit?: number }): boolean {
  return params.offset === undefined && params.limit === undefined;
}

function hashCandidates(paths: string[]): DocsCandidate[] {
  return paths.map((candidatePath) => {
    try {
      return { path: candidatePath, hash: hashDocFile(candidatePath) };
    } catch {
      throw new ContextLoadError(candidatePath);
    }
  });
}

function createEntry(
  candidate: DocsCandidate,
  triggerPath: string,
): DeterministicDocsStateEntry {
  return {
    ...candidate,
    loadedAt: new Date().toISOString(),
    triggerPath,
  };
}

const readTools = new Map<
  string,
  ReturnType<typeof createReadToolDefinition>
>();

function getReadTool(cwd: string) {
  let tool = readTools.get(cwd);
  if (!tool) {
    tool = createReadToolDefinition(cwd);
    readTools.set(cwd, tool);
  }
  return tool;
}

async function defaultLoadInstruction(
  instructionPath: string,
  toolCallId: string,
  ctx: ExtensionContext,
): Promise<ReadResult> {
  return (await getReadTool(ctx.cwd).execute(
    toolCallId,
    { path: instructionPath },
    ctx.signal,
    undefined,
    ctx,
  )) as ReadResult;
}

export function createDeterministicDocsExtension(
  options: DeterministicDocsRuntimeOptions = {},
) {
  const loadInstruction = options.loadInstruction ?? defaultLoadInstruction;

  return function deterministicDocs(pi: ExtensionAPI) {
    let startupSeen = new Map<string, DocsCandidate>();
    let state = { seenIdentities: new Set<string>() };
    let reservations = new ReservationCoordinator();
    let explicitPreflights = new Map<string, ExplicitPreflight>();

    const reconstructBranch = (ctx: ExtensionContext) => {
      state = restoreDeterministicDocsState(ctx, startupSeen.values());
      reservations = new ReservationCoordinator();
      explicitPreflights = new Map<string, ExplicitPreflight>();
    };

    pi.on("session_start", async (_event, ctx) => {
      startupSeen = new Map<string, DocsCandidate>();
      reconstructBranch(ctx);
    });

    pi.on("session_tree", async (_event, ctx) => {
      reconstructBranch(ctx);
    });

    pi.on("before_agent_start", async (event, ctx) => {
      for (const contextFile of event.systemPromptOptions.contextFiles ?? []) {
        if (!isInstructionFilePath(contextFile.path)) continue;
        const canonicalPath = canonicalizeExistingFile(ctx.cwd, contextFile.path);
        if (!canonicalPath) continue;

        const candidate = {
          path: canonicalPath,
          hash: hashDocContent(contextFile.content),
        };
        startupSeen.set(
          observationKey(candidate.path, candidate.hash),
          candidate,
        );
      }
      mergeSeenCandidates(state, startupSeen.values());
    });

    pi.on("tool_call", async (event, ctx) => {
      if (!isToolCallEventType("read", event) || !isCompleteRead(event.input)) {
        return undefined;
      }

      const target = resolveReadTarget(ctx.cwd, event.input.path);
      if (!target) return undefined;

      const candidatePaths = findAncestorDocsFiles(target);
      if (!candidatePaths.includes(target.canonicalPath)) return undefined;

      let candidates: DocsCandidate[];
      try {
        candidates = hashCandidates(candidatePaths);
      } catch {
        return undefined;
      }

      const reservedKeys = new Set<string>();
      for (const candidate of candidates) {
        if (!shouldReadDocsFile(state, candidate)) continue;
        if (reservations.tryReserve(candidate, event.toolCallId) === "blocked") {
          break;
        }
        reservedKeys.add(observationKey(candidate.path, candidate.hash));
      }

      explicitPreflights.set(event.toolCallId, {
        target,
        candidates,
        reservedKeys,
      });
      return undefined;
    });

    pi.on("tool_result", async (event, ctx) => {
      if (!isReadToolResult(event)) return undefined;

      const preflight = explicitPreflights.get(event.toolCallId);
      explicitPreflights.delete(event.toolCallId);
      if (event.isError) {
        if (preflight) {
          reservations.finalize(
            preflight.reservedKeys,
            event.toolCallId,
            "rolled-back",
          );
        }
        return undefined;
      }

      const params = event.input as {
        path?: string;
        offset?: number;
        limit?: number;
      };
      if (!params.path) return undefined;

      const targetResult = {
        content: event.content,
        details: event.details,
      } as ReadResult;
      const target = resolveReadTarget(ctx.cwd, params.path);
      if (!target) {
        if (preflight) {
          reservations.finalize(
            preflight.reservedKeys,
            event.toolCallId,
            "rolled-back",
          );
        }
        return undefined;
      }

      const candidatePaths = findAncestorDocsFiles(target);
      const completeExplicitTarget =
        isCompleteRead(params) && candidatePaths.includes(target.canonicalPath);
      let candidates: DocsCandidate[];

      try {
        candidates = hashCandidates(candidatePaths).map((candidate) => {
          if (!completeExplicitTarget || candidate.path !== target.canonicalPath) {
            return candidate;
          }
          return (
            preflight?.candidates.find(
              (reserved) => reserved.path === target.canonicalPath,
            ) ?? candidate
          );
        });
      } catch (error) {
        if (preflight) {
          reservations.finalize(
            preflight.reservedKeys,
            event.toolCallId,
            "rolled-back",
          );
        }
        const contextPath =
          error instanceof ContextLoadError ? error.contextPath : target.canonicalPath;
        return failedContextResult(targetResult, contextPath);
      }

      const candidateKeys = new Set(
        candidates.map((candidate) =>
          observationKey(candidate.path, candidate.hash),
        ),
      );
      const transactionKeys = new Set<string>();
      if (preflight) {
        for (const key of preflight.reservedKeys) {
          if (candidateKeys.has(key)) {
            transactionKeys.add(key);
          } else {
            reservations.finalize([key], event.toolCallId, "rolled-back");
          }
        }
      }

      const stagedEntries: DeterministicDocsStateEntry[] = [];
      const autoLoaded: AutoLoadedDocsRead[] = [];
      const skipped: string[] = [];

      try {
        for (const candidate of candidates) {
          const isTarget = candidate.path === target.canonicalPath;
          if (isTarget && !completeExplicitTarget) {
            skipped.push(candidate.path);
            continue;
          }
          if (!shouldReadDocsFile(state, candidate)) {
            skipped.push(candidate.path);
            continue;
          }

          const acquisition = await reservations.acquire(
            candidate,
            event.toolCallId,
            () => !shouldReadDocsFile(state, candidate),
            ctx.signal,
          );
          if (acquisition === "skipped") {
            skipped.push(candidate.path);
            continue;
          }

          const key = observationKey(candidate.path, candidate.hash);
          transactionKeys.add(key);
          const entry = createEntry(candidate, target.canonicalPath);
          if (isTarget) {
            reservations.markLoadSucceeded(key, event.toolCallId);
            stagedEntries.push(entry);
            continue;
          }

          try {
            const result = await loadInstruction(
              candidate.path,
              event.toolCallId,
              ctx,
            );
            reservations.markLoadSucceeded(key, event.toolCallId);
            stagedEntries.push(entry);
            autoLoaded.push({ entry, result });
          } catch {
            reservations.markLoadFailed(key, event.toolCallId);
            throw new ContextLoadError(candidate.path);
          }
        }

        const committedEntries = commitDocsFiles(
          state,
          stagedEntries,
          pi.appendEntry,
        );
        const committedKeys = new Set(
          committedEntries.map((entry) => observationKey(entry.path, entry.hash)),
        );
        const committedAutoLoads = autoLoaded.filter(({ entry }) =>
          committedKeys.has(observationKey(entry.path, entry.hash)),
        );
        reservations.finalize(
          transactionKeys,
          event.toolCallId,
          "committed",
        );

        if (committedAutoLoads.length === 0) return undefined;
        const patched = composeReadResult({
          autoLoaded: committedAutoLoads,
          skipped,
          targetResult,
        });
        return {
          content: patched.content,
          details: patched.details,
        };
      } catch (error) {
        reservations.finalize(
          transactionKeys,
          event.toolCallId,
          "rolled-back",
        );
        const contextPath =
          error instanceof ContextLoadError ? error.contextPath : target.canonicalPath;
        return failedContextResult(targetResult, contextPath);
      }
    });
  };
}

export default createDeterministicDocsExtension();
