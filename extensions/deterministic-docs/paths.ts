import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedReadTarget } from "./types";

const CONTEXT_FILE_NAME_PRIORITY = ["AGENTS.md", "CLAUDE.md"] as const;
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

function normalizeUnicodeSpaces(value: string): string {
  return value.replace(UNICODE_SPACES, " ");
}

function normalizeAtPrefix(filePath: string): string {
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function expandPath(filePath: string): string {
  const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
  if (normalized === "~") return os.homedir();
  if (normalized.startsWith("~/")) return os.homedir() + normalized.slice(1);
  return normalized;
}

function fileExists(filePath: string): boolean {
  try {
    accessSync(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function tryMacOSScreenshotPath(filePath: string): string {
  return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
  return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
  return filePath.replace(/'/g, "\u2019");
}

function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (path.isAbsolute(expanded)) return expanded;
  return path.resolve(cwd, expanded);
}

function resolveReadPath(filePath: string, cwd: string): string {
  const resolved = resolveToCwd(filePath, cwd);
  if (fileExists(resolved)) return resolved;

  const amPmVariant = tryMacOSScreenshotPath(resolved);
  if (amPmVariant !== resolved && fileExists(amPmVariant)) return amPmVariant;

  const nfdVariant = tryNFDVariant(resolved);
  if (nfdVariant !== resolved && fileExists(nfdVariant)) return nfdVariant;

  const curlyVariant = tryCurlyQuoteVariant(resolved);
  if (curlyVariant !== resolved && fileExists(curlyVariant)) return curlyVariant;

  const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
  if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) return nfdCurlyVariant;

  return resolved;
}

function canonicalRegularFile(filePath: string): string | undefined {
  try {
    const canonicalPath = realpathSync(filePath);
    return statSync(canonicalPath).isFile() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}

function canonicalDirectory(directoryPath: string): string | undefined {
  try {
    const canonicalPath = realpathSync(directoryPath);
    return statSync(canonicalPath).isDirectory() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}

function isWithinCwd(canonicalCwd: string, canonicalPath: string): boolean {
  const relativePath = path.relative(canonicalCwd, canonicalPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== ".." &&
      !path.isAbsolute(relativePath))
  );
}

export function resolveReadTarget(
  cwd: string,
  inputPath: string,
): ResolvedReadTarget | undefined {
  const canonicalCwd = canonicalDirectory(path.resolve(cwd));
  if (!canonicalCwd) return undefined;

  const canonicalPath = canonicalRegularFile(resolveReadPath(inputPath, cwd));
  if (!canonicalPath || !isWithinCwd(canonicalCwd, canonicalPath)) {
    return undefined;
  }

  return {
    requestedPath: inputPath,
    canonicalCwd,
    canonicalPath,
  };
}

function directoriesForTarget(target: ResolvedReadTarget): string[] {
  const targetDirectory = path.dirname(target.canonicalPath);
  if (!isWithinCwd(target.canonicalCwd, targetDirectory)) return [];

  const relativeDirectory = path.relative(target.canonicalCwd, targetDirectory);
  if (relativeDirectory === "") return [target.canonicalCwd];

  const directories = [target.canonicalCwd];
  let current = target.canonicalCwd;
  for (const segment of relativeDirectory.split(path.sep)) {
    current = path.join(current, segment);
    directories.push(current);
  }
  return directories;
}

function pathEntryExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function instructionFileIn(directory: string): string | undefined {
  for (const [index, fileName] of CONTEXT_FILE_NAME_PRIORITY.entries()) {
    const candidate = path.join(directory, fileName);
    const exists = pathEntryExists(candidate);
    const canonicalPath = canonicalRegularFile(candidate);
    if (canonicalPath) return canonicalPath;
    if (index === 0 && exists) return undefined;
  }
  return undefined;
}

export function findAncestorDocsFiles(target: ResolvedReadTarget): string[] {
  return directoriesForTarget(target).flatMap((directory) => {
    const candidate = instructionFileIn(directory);
    return candidate ? [candidate] : [];
  });
}
