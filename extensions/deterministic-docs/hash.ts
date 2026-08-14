import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";

export function hashDocContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hashDocFile(filePath: string): string {
  return hashDocContent(readFileSync(realpathSync(filePath), "utf8"));
}
