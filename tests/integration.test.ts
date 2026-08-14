import { chmodSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionHarness, loadedPaths, textBlocks } from "./extension-harness";
import { createFixture, type Fixture } from "./fixtures";

describe("read policy integration", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("does nothing when the original target read is an error", async () => {
    fixture.file("project/AGENTS.md", "instructions");
    fixture.file("project/target.ts");
    fixture.file("project/retry.ts");
    const loader = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "instructions" }],
      details: undefined,
    }));
    const harness = new ExtensionHarness(fixture.directory("project"), {
      loadInstruction: loader,
    });
    await harness.start();

    const failed = await harness.result({
      toolCallId: "failed",
      path: "target.ts",
      isError: true,
    });

    expect(failed).toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
    expect(harness.appended).toEqual([]);

    const retry = await harness.result({
      toolCallId: "retry",
      path: "retry.ts",
    });
    expect(loadedPaths(retry)).toEqual([fixture.canonical("project/AGENTS.md")]);
  });

  it("fails closed without exposing target content or partial observations", async () => {
    const rootInstructions = fixture.file("project/AGENTS.md", "root");
    const nestedInstructions = fixture.file("project/nested/AGENTS.md", "nested");
    fixture.file("project/nested/target.ts");
    const loader = vi.fn(async (instructionPath: string) => {
      if (instructionPath === nestedInstructions) {
        throw new Error("nested read failed");
      }
      return {
        content: [{ type: "text" as const, text: "root" }],
        details: undefined,
      };
    });
    const harness = new ExtensionHarness(fixture.directory("project"), {
      loadInstruction: loader,
    });
    await harness.start();

    const result = await harness.result({
      toolCallId: "target",
      path: "nested/target.ts",
      text: "private target content",
      details: { existingField: "preserved" },
    });

    expect(result?.isError).toBe(true);
    expect(textBlocks(result)).toEqual([
      `Cannot load required instruction file: ${nestedInstructions}`,
    ]);
    expect(textBlocks(result).join("\n")).not.toContain("private target content");
    expect(result?.details).toMatchObject({
      existingField: "preserved",
      deterministicDocs: {
        loaded: [],
        skipped: [],
        autoContextContentBlocks: 0,
      },
    });
    expect(harness.appended).toEqual([]);
    expect(loader.mock.calls.map(([path]) => path)).toEqual([
      rootInstructions,
      nestedInstructions,
    ]);
  });

  it("keeps a complete explicit read unchanged when no ancestor is new", async () => {
    fixture.file("project/AGENTS.md", "instructions");
    const harness = new ExtensionHarness(fixture.directory("project"));
    await harness.start();
    await harness.preflight("explicit", "AGENTS.md");

    const result = await harness.result({
      toolCallId: "explicit",
      path: "AGENTS.md",
      text: "instructions",
    });

    expect(result).toBeUndefined();
    expect(harness.appended).toHaveLength(1);
  });

  it("prepends only new ancestors to a complete explicit instruction read", async () => {
    fixture.file("project/AGENTS.md", "root");
    fixture.file("project/nested/CLAUDE.md", "nested");
    const harness = new ExtensionHarness(fixture.directory("project"));
    await harness.start();
    await harness.preflight("explicit", "nested/CLAUDE.md");

    const result = await harness.result({
      toolCallId: "explicit",
      path: "nested/CLAUDE.md",
      text: "nested",
    });

    expect(loadedPaths(result)).toEqual([fixture.canonical("project/AGENTS.md")]);
    expect(textBlocks(result).at(-1)).toBe("nested");
    expect(textBlocks(result).join("\n")).not.toContain(
      `## Auto-loaded context: ${fixture.canonical("project/nested/CLAUDE.md")}`,
    );
    expect(harness.appended).toHaveLength(2);
  });

  it("rolls back an explicit self-observation when an ancestor fails", async () => {
    const rootInstructions = fixture.file("project/AGENTS.md", "root");
    fixture.file("project/nested/AGENTS.md", "nested");
    const harness = new ExtensionHarness(fixture.directory("project"), {
      loadInstruction: async () => {
        throw new Error("ancestor failed");
      },
    });
    await harness.start();
    await harness.preflight("explicit", "nested/AGENTS.md");

    const result = await harness.result({
      toolCallId: "explicit",
      path: "nested/AGENTS.md",
      text: "nested",
    });

    expect(result?.isError).toBe(true);
    expect(textBlocks(result)).toEqual([
      `Cannot load required instruction file: ${rootInstructions}`,
    ]);
    expect(harness.appended).toEqual([]);
  });

  it("does not persist an unreadable required instruction", async () => {
    const instructionPath = fixture.file("project/AGENTS.md", "instructions");
    fixture.file("project/target.ts");
    chmodSync(instructionPath, 0o000);
    const harness = new ExtensionHarness(fixture.directory("project"));
    await harness.start();

    const result = await harness.result({
      toolCallId: "target",
      path: "target.ts",
    });
    chmodSync(instructionPath, 0o600);

    expect(result?.isError).toBe(true);
    expect(loadedPaths(result)).toEqual([]);
    expect(harness.appended).toEqual([]);
  });

  it("does not persist an instruction that disappears during its nested read", async () => {
    const instructionPath = fixture.file("project/AGENTS.md", "instructions");
    fixture.file("project/target.ts");
    const harness = new ExtensionHarness(fixture.directory("project"), {
      loadInstruction: async () => {
        unlinkSync(instructionPath);
        throw new Error("instruction disappeared");
      },
    });
    await harness.start();

    const result = await harness.result({
      toolCallId: "target",
      path: "target.ts",
    });

    expect(result?.isError).toBe(true);
    expect(loadedPaths(result)).toEqual([]);
    expect(harness.appended).toEqual([]);
  });

  it("reconstructs eligibility when tree navigation changes the active branch", async () => {
    fixture.file("project/AGENTS.md", "instructions");
    fixture.file("project/first.ts");
    fixture.file("project/before.ts");
    fixture.file("project/after.ts");
    const loader = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "instructions" }],
      details: undefined,
    }));
    const harness = new ExtensionHarness(fixture.directory("project"), {
      loadInstruction: loader,
    });
    await harness.start();

    await harness.result({ toolCallId: "first", path: "first.ts" });
    const observedLeaf = harness.sessionManager.getLeafId();
    if (!observedLeaf) throw new Error("Expected an observation entry");

    harness.sessionManager.resetLeaf();
    await harness.navigateTree();
    const before = await harness.result({
      toolCallId: "before",
      path: "before.ts",
    });
    expect(loadedPaths(before)).toEqual([fixture.canonical("project/AGENTS.md")]);

    harness.sessionManager.branch(observedLeaf);
    await harness.navigateTree();
    const after = await harness.result({
      toolCallId: "after",
      path: "after.ts",
    });
    expect(after).toBeUndefined();
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
