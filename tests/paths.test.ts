import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findAncestorDocsFiles,
  resolveReadTarget,
} from "../extensions/deterministic-docs/paths";
import { createFixture, type Fixture } from "./fixtures";

function discover(cwd: string, targetPath: string): string[] {
  const target = resolveReadTarget(cwd, targetPath);
  return target ? findAncestorDocsFiles(target) : [];
}

describe("cwd-bounded instruction discovery", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("discovers instruction files from cwd to the target directory", () => {
    fixture.file("project/AGENTS.md", "root instructions");
    fixture.file("project/packages/CLAUDE.md", "package instructions");
    fixture.file("project/packages/app/AGENTS.md", "app instructions");
    fixture.file("project/packages/app/src/main.ts", "target");

    const cwd = fixture.directory("project");

    expect(discover(cwd, "packages/app/src/main.ts")).toEqual([
      fixture.canonical("project/AGENTS.md"),
      fixture.canonical("project/packages/CLAUDE.md"),
      fixture.canonical("project/packages/app/AGENTS.md"),
    ]);
  });

  it("selects AGENTS.md instead of CLAUDE.md in the same directory", () => {
    fixture.file("project/AGENTS.md");
    fixture.file("project/CLAUDE.md");
    fixture.file("project/main.ts");

    expect(discover(fixture.directory("project"), "main.ts")).toEqual([
      fixture.canonical("project/AGENTS.md"),
    ]);
  });

  it("does not select CLAUDE.md when AGENTS.md exists but is not a file", () => {
    fixture.directory("project/AGENTS.md");
    fixture.file("project/CLAUDE.md");
    fixture.file("project/main.ts");

    expect(discover(fixture.directory("project"), "main.ts")).toEqual([]);
  });

  it("ignores README variants", () => {
    fixture.file("project/README.md");
    fixture.file("project/nested/readme.md");
    fixture.file("project/nested/main.ts");

    expect(discover(fixture.directory("project"), "nested/main.ts")).toEqual(
      [],
    );
  });

  it("does not discover instructions for skill files", () => {
    fixture.file("project/AGENTS.md");
    fixture.file("project/.agents/skills/one/SKILL.md");
    fixture.file("project/.pi/skills/two/SKILL.md");
    fixture.file("project/.pi/agent/skills/three/SKILL.md");
    const cwd = fixture.directory("project");

    expect(discover(cwd, ".agents/skills/one/SKILL.md")).toEqual([]);
    expect(discover(cwd, ".pi/skills/two/SKILL.md")).toEqual([]);
    expect(discover(cwd, ".pi/agent/skills/three/SKILL.md")).toEqual([]);
  });

  it("uses the requested skill path when canonicalization removes its marker", () => {
    fixture.file("project/AGENTS.md");
    fixture.file("project/config/agent/skills/example/SKILL.md");
    fixture.symlink(fixture.directory("project/config"), "project/.pi");

    expect(
      discover(
        fixture.directory("project"),
        ".pi/agent/skills/example/SKILL.md",
      ),
    ).toEqual([]);
  });

  it("rejects absolute and relative targets outside cwd", () => {
    fixture.file("workspace/project/main.ts");
    const outsidePath = fixture.file("workspace/outside.ts");
    const cwd = fixture.directory("workspace/project");

    expect(resolveReadTarget(cwd, outsidePath)).toBeUndefined();
    expect(
      resolveReadTarget(cwd, path.join("..", "outside.ts")),
    ).toBeUndefined();
  });

  it("uses the same canonical identities for direct and symlink targets", () => {
    fixture.file("project/AGENTS.md");
    const directTarget = fixture.file("project/src/main.ts");
    const symlinkTarget = fixture.symlink(directTarget, "project/main-link.ts");
    const cwd = fixture.directory("project");

    const direct = resolveReadTarget(cwd, directTarget);
    const linked = resolveReadTarget(cwd, symlinkTarget);

    expect(direct).toBeDefined();
    expect(linked).toBeDefined();
    expect(linked?.canonicalPath).toBe(direct?.canonicalPath);
    expect(linked && findAncestorDocsFiles(linked)).toEqual(
      direct && findAncestorDocsFiles(direct),
    );
  });

  it("uses canonical instruction paths for symlink candidates", () => {
    const instructionTarget = fixture.file("shared/instructions.md");
    fixture.symlink(instructionTarget, "project/AGENTS.md");
    fixture.file("project/main.ts");

    expect(discover(fixture.directory("project"), "main.ts")).toEqual([
      fixture.canonical("shared/instructions.md"),
    ]);
  });

  it("rejects missing and non-file targets", () => {
    const cwd = fixture.directory("project");
    fixture.directory("project/nested");

    expect(resolveReadTarget(cwd, "missing.ts")).toBeUndefined();
    expect(resolveReadTarget(cwd, "nested")).toBeUndefined();
  });

  it("rejects a symlink target that resolves outside cwd", () => {
    const outsidePath = fixture.file("outside.ts");
    fixture.symlink(outsidePath, "project/outside-link.ts");

    expect(
      resolveReadTarget(fixture.directory("project"), "outside-link.ts"),
    ).toBeUndefined();
  });
});
