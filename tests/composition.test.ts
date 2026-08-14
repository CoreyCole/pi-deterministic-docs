import { describe, expect, it } from "vitest";
import {
  composeReadResult,
  type AutoLoadedDocsRead,
  type ReadResult,
} from "../extensions/deterministic-docs/index";
import type { DeterministicDocsStateEntry } from "../extensions/deterministic-docs/types";

function loadedDoc(
  path: string,
  body: string,
  hash = `hash:${path}`,
): AutoLoadedDocsRead {
  const entry: DeterministicDocsStateEntry = {
    path,
    hash,
    loadedAt: "2026-08-14T00:00:00.000Z",
    triggerPath: "/project/src/target.ts",
  };
  return {
    entry,
    result: {
      content: [{ type: "text", text: body }],
      details: undefined,
    },
  };
}

describe("read result composition", () => {
  it("prepends one context block before unchanged mixed target blocks", () => {
    const targetContent: ReadResult["content"] = [
      { type: "text", text: "target text" },
      { type: "image", data: "base64-data", mimeType: "image/png" },
      { type: "text", text: "target tail" },
    ];
    const targetResult: ReadResult = {
      content: targetContent,
      details: undefined,
    };

    const composed = composeReadResult({
      autoLoaded: [loadedDoc("/project/AGENTS.md", "root instructions")],
      skipped: [],
      targetResult,
    });

    expect(composed.content).toHaveLength(4);
    expect(composed.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("root instructions"),
    });
    expect(composed.content.slice(1)).toEqual(targetContent);
    expect(composed.content[1]).toBe(targetContent[0]);
    expect(composed.content[2]).toBe(targetContent[1]);
    expect(composed.content[3]).toBe(targetContent[2]);
  });

  it("combines multiple instructions into one root-to-leaf prefix", () => {
    const root = loadedDoc("/project/AGENTS.md", "root instructions");
    const leaf = loadedDoc(
      "/project/packages/app/CLAUDE.md",
      "leaf instructions",
    );

    const composed = composeReadResult({
      autoLoaded: [root, leaf],
      skipped: ["/project/seen/AGENTS.md"],
      targetResult: {
        content: [{ type: "text", text: "target" }],
        details: undefined,
      },
    });

    expect(composed.content).toHaveLength(2);
    const prefix = composed.content[0];
    expect(prefix?.type).toBe("text");
    if (prefix?.type !== "text") throw new Error("Expected a text prefix");
    expect(prefix.text.indexOf(root.entry.path)).toBeLessThan(
      prefix.text.indexOf(leaf.entry.path),
    );
    expect(composed.details?.deterministicDocs).toEqual({
      loaded: [root.entry, leaf.entry],
      skipped: ["/project/seen/AGENTS.md"],
      autoContextContentBlocks: 1,
    });
  });

  it("preserves existing target details", () => {
    const targetResult = {
      content: [{ type: "text" as const, text: "target" }],
      details: {
        truncation: {
          truncated: false,
          content: "target",
          outputLines: 1,
          outputBytes: 6,
          totalLines: 1,
          totalBytes: 6,
        },
        existingField: "keep me",
      },
    } as unknown as ReadResult;

    const composed = composeReadResult({
      autoLoaded: [loadedDoc("/project/AGENTS.md", "instructions")],
      skipped: [],
      targetResult,
    });

    expect(composed.details).toMatchObject({
      truncation: targetResult.details?.truncation,
      existingField: "keep me",
    });
  });

  it("returns the exact original result when no context is new", () => {
    const targetResult: ReadResult = {
      content: [{ type: "text", text: "target" }],
      details: undefined,
    };

    expect(
      composeReadResult({
        autoLoaded: [],
        skipped: ["/project/AGENTS.md"],
        targetResult,
      }),
    ).toBe(targetResult);
  });
});
