import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashDocContent } from "../extensions/deterministic-docs/hash";
import {
  ExtensionHarness,
  loadedPaths,
  textBlocks,
} from "./extension-harness";
import { createFixture, type Fixture } from "./fixtures";

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
} {
  let resolve = () => {};
  let reject = (_error: Error) => {};
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("transactional read observations", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("seeds startup content without appending and reloads only a newer disk hash", async () => {
    const agentsPath = fixture.file("project/AGENTS.md", "startup content");
    fixture.file("project/first.ts");
    fixture.file("project/second.ts");
    const loader = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "new disk content" }],
      details: undefined,
    }));
    const harness = new ExtensionHarness(fixture.directory("project"), {
      loadInstruction: loader,
    });
    await harness.start();

    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "read",
      systemPrompt: "",
      systemPromptOptions: {
        cwd: harness.cwd,
        contextFiles: [{ path: agentsPath, content: "startup content" }],
      },
    });

    expect(harness.appended).toEqual([]);
    expect(await harness.result({ toolCallId: "first", path: "first.ts" })).toBeUndefined();
    expect(loader).not.toHaveBeenCalled();

    fixture.file("project/AGENTS.md", "new disk content");
    const changed = await harness.result({
      toolCallId: "second",
      path: "second.ts",
    });

    expect(loadedPaths(changed)).toEqual([fixture.canonical("project/AGENTS.md")]);
    expect(harness.appended).toHaveLength(1);
    expect(harness.appended[0]?.data).toMatchObject({
      hash: hashDocContent("new disk content"),
    });
  });

  it("injects and appends one observation for parallel automatic reads", async () => {
    fixture.file("project/AGENTS.md", "instructions");
    fixture.file("project/a.ts");
    fixture.file("project/b.ts");
    const gate = deferred();
    const loader = vi.fn(async () => {
      await gate.promise;
      return {
        content: [{ type: "text" as const, text: "instructions" }],
        details: undefined,
      };
    });
    const harness = new ExtensionHarness(fixture.directory("project"), {
      loadInstruction: loader,
    });
    await harness.start();

    const first = harness.result({ toolCallId: "a", path: "a.ts" });
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
    const second = harness.result({ toolCallId: "b", path: "b.ts" });
    gate.resolve();
    const results = await Promise.all([first, second]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(loader).toHaveBeenCalledOnce();
    expect(harness.appended).toHaveLength(1);
  });

  it("gives a complete explicit read preflight ownership over an automatic sibling", async () => {
    fixture.file("project/AGENTS.md", "root instructions");
    fixture.file("project/nested/AGENTS.md", "nested instructions");
    fixture.file("project/nested/target.ts");
    const loader = vi.fn(async (instructionPath: string) => ({
      content: [{ type: "text" as const, text: `loaded:${instructionPath}` }],
      details: undefined,
    }));
    const harness = new ExtensionHarness(fixture.directory("project"), {
      loadInstruction: loader,
    });
    await harness.start();
    await harness.preflight("explicit", "nested/AGENTS.md");

    const automatic = harness.result({
      toolCallId: "automatic",
      path: "nested/target.ts",
    });
    const explicit = harness.result({
      toolCallId: "explicit",
      path: "nested/AGENTS.md",
      text: "nested instructions",
    });
    const [automaticResult, explicitResult] = await Promise.all([
      automatic,
      explicit,
    ]);

    expect(automaticResult).toBeUndefined();
    expect(loadedPaths(explicitResult)).toEqual([
      fixture.canonical("project/AGENTS.md"),
    ]);
    expect(textBlocks(explicitResult).at(-1)).toBe("nested instructions");
    expect(textBlocks(explicitResult).join("\n")).not.toContain(
      "## Auto-loaded context: " + fixture.canonical("project/nested/AGENTS.md"),
    );
    expect(loader).toHaveBeenCalledOnce();
    expect(harness.appended).toHaveLength(2);
  });

  it("does not reserve or persist a ranged explicit target", async () => {
    fixture.file("project/AGENTS.md", "root instructions");
    fixture.file("project/nested/AGENTS.md", "nested instructions");
    const loader = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "root instructions" }],
      details: undefined,
    }));
    const harness = new ExtensionHarness(fixture.directory("project"), {
      loadInstruction: loader,
    });
    await harness.start();
    await harness.preflight("ranged", "nested/AGENTS.md", { limit: 1 });

    const result = await harness.result({
      toolCallId: "ranged",
      path: "nested/AGENTS.md",
      text: "nested instructions line 1",
      limit: 1,
    });

    expect(loadedPaths(result)).toEqual([fixture.canonical("project/AGENTS.md")]);
    expect(harness.appended).toHaveLength(1);
    expect(harness.appended[0]?.data).toMatchObject({
      path: fixture.canonical("project/AGENTS.md"),
    });
  });

  it("makes a changed content hash eligible again", async () => {
    fixture.file("project/AGENTS.md", "version one");
    fixture.file("project/a.ts");
    fixture.file("project/b.ts");
    const loader = vi.fn(async (instructionPath: string) => ({
      content: [{ type: "text" as const, text: instructionPath }],
      details: undefined,
    }));
    const harness = new ExtensionHarness(fixture.directory("project"), {
      loadInstruction: loader,
    });
    await harness.start();

    await harness.result({ toolCallId: "first", path: "a.ts" });
    fixture.file("project/AGENTS.md", "version two");
    await harness.result({ toolCallId: "second", path: "b.ts" });

    expect(loader).toHaveBeenCalledTimes(2);
    expect(harness.appended).toHaveLength(2);
    expect(harness.appended.map((entry) => entry.data)).toEqual([
      expect.objectContaining({ hash: hashDocContent("version one") }),
      expect.objectContaining({ hash: hashDocContent("version two") }),
    ]);
  });

  it("rolls back cancellation and lets a later read retry", async () => {
    fixture.file("project/AGENTS.md", "instructions");
    fixture.file("project/a.ts");
    fixture.file("project/b.ts");
    let attempt = 0;
    const loader = vi.fn(async (_path: string, _toolCallId: string, ctx: ExtensionContext) => {
      attempt += 1;
      if (attempt === 1) {
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(new Error("Operation aborted"));
          ctx.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      return {
        content: [{ type: "text" as const, text: "instructions" }],
        details: undefined,
      };
    });
    const harness = new ExtensionHarness(fixture.directory("project"), {
      loadInstruction: loader,
    });
    await harness.start();
    const controller = new AbortController();

    const cancelled = harness.result({
      toolCallId: "cancelled",
      path: "a.ts",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
    controller.abort();
    const cancelledResult = await cancelled;

    expect(cancelledResult?.isError).toBe(true);
    expect(harness.appended).toEqual([]);

    const retry = await harness.result({ toolCallId: "retry", path: "b.ts" });
    expect(loadedPaths(retry)).toEqual([fixture.canonical("project/AGENTS.md")]);
    expect(harness.appended).toHaveLength(1);
  });

  it("lets a sibling claim shared context after the first transaction fails", async () => {
    const rootInstructions = fixture.file("project/AGENTS.md", "root");
    const failingInstructions = fixture.file("project/a/AGENTS.md", "a");
    fixture.file("project/a/target.ts");
    fixture.file("project/b/target.ts");
    const failingLoadStarted = deferred();
    const releaseFailure = deferred();
    const loader = vi.fn(async (instructionPath: string) => {
      if (instructionPath === failingInstructions) {
        failingLoadStarted.resolve();
        await releaseFailure.promise;
        throw new Error("nested read failed");
      }
      return {
        content: [{ type: "text" as const, text: `loaded:${instructionPath}` }],
        details: undefined,
      };
    });
    const harness = new ExtensionHarness(fixture.directory("project"), {
      loadInstruction: loader,
    });
    await harness.start();

    const failing = harness.result({ toolCallId: "failing", path: "a/target.ts" });
    await failingLoadStarted.promise;
    const sibling = harness.result({ toolCallId: "sibling", path: "b/target.ts" });
    releaseFailure.resolve();
    const [failedResult, siblingResult] = await Promise.all([failing, sibling]);

    expect(failedResult?.isError).toBe(true);
    expect(loadedPaths(failedResult)).toEqual([]);
    expect(loadedPaths(siblingResult)).toEqual([rootInstructions]);
    expect(loader.mock.calls.filter(([path]) => path === rootInstructions)).toHaveLength(2);
    expect(harness.appended).toHaveLength(1);
    expect(harness.appended[0]?.data).toMatchObject({ path: rootInstructions });
  });

  it("releases explicit preflight reservations after the original read fails", async () => {
    fixture.file("project/AGENTS.md", "instructions");
    fixture.file("project/target.ts");
    const loader = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "instructions" }],
      details: undefined,
    }));
    const harness = new ExtensionHarness(fixture.directory("project"), {
      loadInstruction: loader,
    });
    await harness.start();
    await harness.preflight("explicit", "AGENTS.md");

    await harness.result({
      toolCallId: "explicit",
      path: "AGENTS.md",
      isError: true,
    });
    const retry = await harness.result({
      toolCallId: "automatic",
      path: "target.ts",
    });

    expect(loadedPaths(retry)).toEqual([fixture.canonical("project/AGENTS.md")]);
    expect(harness.appended).toHaveLength(1);
  });

  it("repeats the automatic race without duplicate entries or prefixes", async () => {
    for (let index = 0; index < 20; index += 1) {
      const cwd = fixture.directory(`race-${index}`);
      fixture.file(`race-${index}/AGENTS.md`, `instructions-${index}`);
      fixture.file(`race-${index}/a.ts`);
      fixture.file(`race-${index}/b.ts`);
      const loader = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "instructions" }],
        details: undefined,
      }));
      const harness = new ExtensionHarness(cwd, { loadInstruction: loader });
      await harness.start();

      const results = await Promise.all([
        harness.result({ toolCallId: `a-${index}`, path: "a.ts" }),
        harness.result({ toolCallId: `b-${index}`, path: "b.ts" }),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(harness.appended).toHaveLength(1);
      expect(loader).toHaveBeenCalledOnce();
    }
  });
});
