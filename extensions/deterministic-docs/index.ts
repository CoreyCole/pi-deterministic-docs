import type { ExtensionAPI, ReadToolDetails } from "@mariozechner/pi-coding-agent";
import { createReadToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { findAncestorDocsFiles, resolveReadTarget } from "./paths";
import { hashDocFile } from "./hash";
import { formatDeterministicDocsSummary } from "./render";
import { rememberDocsFile, restoreDeterministicDocsState, shouldReadDocsFile } from "./state";
import type { DeterministicDocsReadDetails, DeterministicDocsStateEntry } from "./types";

type ReadContent = TextContent | ImageContent;
type ReadResult = { content: ReadContent[]; details: (ReadToolDetails & DeterministicDocsReadDetails) | undefined };

type AutoLoadedDocsRead = {
  entry: DeterministicDocsStateEntry;
  result: ReadResult;
};

function textContent(text: string): TextContent {
  return { type: "text", text };
}

function textBlocks(result: ReadResult): string[] {
  return result.content.flatMap((content) => (content.type === "text" ? [content.text] : []));
}

function formatLoadedDocsSection(autoLoaded: AutoLoadedDocsRead[]): string | undefined {
  if (autoLoaded.length === 0) return undefined;

  const sections = autoLoaded.map(({ entry, result }) => {
    const body = textBlocks(result).join("\n").trimEnd();
    return [`## Auto-loaded context: ${entry.path}`, body || "[context file produced no text content]"].join("\n");
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
  const prefix = [loadedSection].filter((part): part is string => Boolean(part));
  const content = prefix.length > 0 ? [textContent(prefix.join("\n\n")), ...args.targetResult.content] : args.targetResult.content;

  return {
    ...args.targetResult,
    content,
    details: {
      ...(args.targetResult.details ?? {}),
      deterministicDocs: { loaded, skipped: args.skipped, autoContextContentBlocks: prefix.length },
    },
  };
}

function inFlightKey(path: string, hash: string): string {
  return `${path}\0${hash}`;
}

function shouldRememberExplicitTarget(params: { offset?: number; limit?: number }): boolean {
  return params.offset === undefined && params.limit === undefined;
}

export default function deterministicDocs(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const originalRead = createReadToolDefinition(cwd);
  let state = { byPath: new Map<string, DeterministicDocsStateEntry>() };
  let inFlightLoads = new Map<string, Promise<AutoLoadedDocsRead>>();

  pi.on("session_start", async (_event, ctx) => {
    state = restoreDeterministicDocsState(ctx);
    inFlightLoads = new Map<string, Promise<AutoLoadedDocsRead>>();
  });

  pi.registerTool({
    name: "read",
    label: originalRead.label,
    description: originalRead.description,
    promptSnippet: originalRead.promptSnippet,
    promptGuidelines: originalRead.promptGuidelines,
    parameters: originalRead.parameters,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const target = resolveReadTarget(cwd, params.path);
      const candidates = findAncestorDocsFiles(target.absolutePath);
      const explicitContextPath = candidates.find((docPath) => docPath === target.absolutePath);
      const autoLoaded: AutoLoadedDocsRead[] = [];
      const skipped: string[] = [];
      let targetResultPromise: Promise<ReadResult> | undefined;

      if (explicitContextPath && shouldRememberExplicitTarget(params)) {
        const hash = hashDocFile(explicitContextPath);
        if (shouldReadDocsFile(state, { path: explicitContextPath, hash })) {
          const key = inFlightKey(explicitContextPath, hash);
          if (!inFlightLoads.has(key)) {
            targetResultPromise = originalRead.execute(toolCallId, params, signal, onUpdate, ctx) as Promise<ReadResult>;
            const loadPromise = targetResultPromise.then((result) => {
              const entry: DeterministicDocsStateEntry = {
                path: explicitContextPath,
                hash,
                loadedAt: new Date().toISOString(),
                triggerPath: target.absolutePath,
              };
              rememberDocsFile(state, entry, pi.appendEntry);
              return { entry, result };
            });
            loadPromise.catch(() => undefined);
            loadPromise
              .finally(() => {
                if (inFlightLoads.get(key) === loadPromise) inFlightLoads.delete(key);
              })
              .catch(() => undefined);
            inFlightLoads.set(key, loadPromise);
          }
        }
      }

      for (const docPath of candidates) {
        if (docPath === target.absolutePath) {
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
          const result = (await originalRead.execute(toolCallId, { path: docPath }, signal, onUpdate, ctx)) as ReadResult;
          const entry: DeterministicDocsStateEntry = {
            path: docPath,
            hash,
            loadedAt: new Date().toISOString(),
            triggerPath: target.absolutePath,
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

      const targetResult = targetResultPromise
        ? await targetResultPromise
        : ((await originalRead.execute(toolCallId, params, signal, onUpdate, ctx)) as ReadResult);
      return composeReadResult({ autoLoaded, skipped, targetResult });
    },

    renderCall: originalRead.renderCall,
    renderResult(result, options, theme, context) {
      const readResult = result as ReadResult;
      const autoContextContentBlocks = readResult.details?.deterministicDocs?.autoContextContentBlocks ?? 0;
      const visibleResult =
        autoContextContentBlocks > 0
          ? { ...readResult, content: readResult.content.slice(autoContextContentBlocks) }
          : readResult;
      const base = originalRead.renderResult?.(visibleResult as any, options, theme, context as any);
      const summary = formatDeterministicDocsSummary(readResult, options, theme);
      if (!summary) return base ?? new Text("", 0, 0);
      if (!base) return new Text(summary, 0, 0);

      const baseLines = base
        .render(200)
        .map((line) => line.trimEnd())
        .join("\n")
        .trimEnd();
      return new Text([summary, baseLines].filter(Boolean).join("\n"), 0, 0);
    },
  });
}
