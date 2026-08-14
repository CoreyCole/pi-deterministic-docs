import type {
  ExtensionAPI,
  ExtensionContext,
  ReadToolDetails,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  createDeterministicDocsExtension,
  type DeterministicDocsRuntimeOptions,
} from "../extensions/deterministic-docs/index";
import type { DeterministicDocsReadDetails } from "../extensions/deterministic-docs/types";

type Handler = (
  event: unknown,
  ctx: ExtensionContext,
) => Promise<unknown> | unknown;

export type ReadPatch = {
  content?: (TextContent | ImageContent)[];
  details?: ReadToolDetails & DeterministicDocsReadDetails;
  isError?: boolean;
};

export class ExtensionHarness {
  readonly appended: Array<{ customType: string; data: unknown }> = [];
  readonly sessionManager: SessionManager;
  private readonly handlers = new Map<string, Handler>();

  constructor(
    readonly cwd: string,
    options: DeterministicDocsRuntimeOptions = {},
  ) {
    this.sessionManager = SessionManager.inMemory(cwd);
    const pi = {
      on: (eventName: string, handler: Handler) => {
        this.handlers.set(eventName, handler);
      },
      appendEntry: (customType: string, data?: unknown) => {
        this.appended.push({ customType, data });
        this.sessionManager.appendCustomEntry(customType, data);
      },
    } as unknown as ExtensionAPI;
    createDeterministicDocsExtension(options)(pi);
  }

  private context(signal?: AbortSignal): ExtensionContext {
    return {
      cwd: this.cwd,
      sessionManager: this.sessionManager,
      signal,
      model: undefined,
    } as unknown as ExtensionContext;
  }

  async emit(
    eventName: string,
    event: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const handler = this.handlers.get(eventName);
    if (!handler) throw new Error(`Missing handler: ${eventName}`);
    return handler(event, this.context(signal));
  }

  async start(): Promise<void> {
    await this.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });
  }

  async navigateTree(): Promise<void> {
    await this.emit("session_tree", {
      type: "session_tree",
      newLeafId: this.sessionManager.getLeafId(),
      oldLeafId: null,
    });
  }

  async preflight(
    toolCallId: string,
    path: string,
    range: { offset?: number; limit?: number } = {},
  ): Promise<void> {
    await this.emit("tool_call", {
      type: "tool_call",
      toolName: "read",
      toolCallId,
      input: { path, ...range },
    });
  }

  async result(args: {
    toolCallId: string;
    path: string;
    content?: (TextContent | ImageContent)[];
    text?: string;
    details?: ReadToolDetails & Record<string, unknown>;
    isError?: boolean;
    offset?: number;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<ReadPatch | undefined> {
    return (await this.emit(
      "tool_result",
      {
        type: "tool_result",
        toolName: "read",
        toolCallId: args.toolCallId,
        input: {
          path: args.path,
          ...(args.offset === undefined ? {} : { offset: args.offset }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        },
        content: args.content ?? [
          { type: "text", text: args.text ?? `target:${args.path}` },
        ],
        details: args.details,
        isError: args.isError ?? false,
      },
      args.signal,
    )) as ReadPatch | undefined;
  }
}

export function loadedPaths(result: ReadPatch | undefined): string[] {
  return result?.details?.deterministicDocs?.loaded.map((entry) => entry.path) ?? [];
}

export function textBlocks(result: ReadPatch | undefined): string[] {
  return (
    result?.content?.flatMap((block) =>
      block.type === "text" ? [block.text] : [],
    ) ?? []
  );
}
