import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Fixture {
  root: string;
  cleanup(): void;
  directory(relativePath: string): string;
  file(relativePath: string, content?: string): string;
  symlink(targetPath: string, relativePath: string): string;
  canonical(relativePath: string): string;
}

export function createFixture(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-deterministic-docs-"));

  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
    directory(relativePath) {
      const directoryPath = path.join(root, relativePath);
      mkdirSync(directoryPath, { recursive: true });
      return directoryPath;
    },
    file(relativePath, content = relativePath) {
      const filePath = path.join(root, relativePath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
      return filePath;
    },
    symlink(targetPath, relativePath) {
      const linkPath = path.join(root, relativePath);
      mkdirSync(path.dirname(linkPath), { recursive: true });
      symlinkSync(targetPath, linkPath);
      return linkPath;
    },
    canonical(relativePath) {
      return realpathSync(path.join(root, relativePath));
    },
  };
}
