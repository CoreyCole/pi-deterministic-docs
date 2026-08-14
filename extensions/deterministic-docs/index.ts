import type {
  ExtensionAPI,
  ReadToolDetails,
} from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { hashDocFile } from "./hash";
import { findAncestorDocsFiles, resolveReadTarget } from "./paths";
import {
  rememberDocsFile,
  restoreDeterministicDocsState,
  shouldReadDocsFile,
} from "./state";
import type {
  DeterministicDocsReadDetails,
  DeterministicDocsStateEntry,
} from "./types";

type ReadContent = TextContent | ImageContent;
type ReadResult = {
  content: ReadContent[];
  details: (ReadToolDetails & DeterministicDocsReadDetails) | undefined;
};

type AutoLoadedDocsRead = {
  entry: DeterministicDocsStateEntry;
  result: ReadResult;
};

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

function composeReadResult(args: {
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
  const content =
    prefix.length > 0
      ? [textContent(prefix.join("\n\n")), ...args.targetResult.content]
      : args.targetResult.content;

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

function inFlightKey(path: string, hash: string): string {
  return `${path}\0${hash}`;
}

function shouldRememberExplicitTarget(params: {
  offset?: number;
  limit?: number;
}): boolean {
  return params.offset === undefined && params.limit === undefined;
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

export default function deterministicDocs(pi: ExtensionAPI) {
  let state = { byPath: new Map<string, DeterministicDocsStateEntry>() };
  let inFlightLoads = new Map<string, Promise<AutoLoadedDocsRead>>();

  pi.on("session_start", async (_event, ctx) => {
    state = restoreDeterministicDocsState(ctx);
    inFlightLoads = new Map<string, Promise<AutoLoadedDocsRead>>();
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read" || event.isError) return undefined;

    const params = event.input as {
      path: string;
      offset?: number;
      limit?: number;
    };
    if (!params?.path) return undefined;

    const cwd = ctx.cwd;
    const readTool = getReadTool(cwd);
    const target = resolveReadTarget(cwd, params.path);
    if (!target) return undefined;

    const candidates = findAncestorDocsFiles(target);
    const explicitContextPath = candidates.find(
      (docPath) => docPath === target.canonicalPath,
    );
    const autoLoaded: AutoLoadedDocsRead[] = [];
    const skipped: string[] = [];
    const targetResult = {
      content: event.content,
      details: event.details,
    } as ReadResult;

    if (explicitContextPath && shouldRememberExplicitTarget(params)) {
      const hash = hashDocFile(explicitContextPath);
      if (shouldReadDocsFile(state, { path: explicitContextPath, hash })) {
        const entry: DeterministicDocsStateEntry = {
          path: explicitContextPath,
          hash,
          loadedAt: new Date().toISOString(),
          triggerPath: target.canonicalPath,
        };
        rememberDocsFile(state, entry, pi.appendEntry);
      }
    }

    for (const docPath of candidates) {
      if (docPath === target.canonicalPath) {
        skipped.push(docPath);
        continue;
      }

      const hash = hashDocFile(docPath);
      if (!shouldReadDocsFile(state, { path: docPath, hash })) {
        skipped.push(docPath);
        continue;
      }

      const key = inFlightKey(docPath, hash);
      const inFlightLoad = inFlightLoads.get(key);
      if (inFlightLoad) {
        await inFlightLoad;
        skipped.push(docPath);
        continue;
      }

      const loadPromise = (async () => {
        const result = (await readTool.execute(
          event.toolCallId,
          { path: docPath },
          ctx.signal,
          undefined,
          ctx,
        )) as ReadResult;
        const entry: DeterministicDocsStateEntry = {
          path: docPath,
          hash,
          loadedAt: new Date().toISOString(),
          triggerPath: target.canonicalPath,
        };
        rememberDocsFile(state, entry, pi.appendEntry);
        return { entry, result };
      })();
      inFlightLoads.set(key, loadPromise);
      try {
        autoLoaded.push(await loadPromise);
      } finally {
        if (inFlightLoads.get(key) === loadPromise) inFlightLoads.delete(key);
      }
    }

    const patched = composeReadResult({ autoLoaded, skipped, targetResult });
    return {
      content: patched.content,
      details: patched.details,
    };
  });
}
