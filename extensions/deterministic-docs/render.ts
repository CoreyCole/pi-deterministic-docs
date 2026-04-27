import type { Theme, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { DeterministicDocsReadDetails } from "./types";

export function formatDeterministicDocsSummary(
  result: { details?: DeterministicDocsReadDetails },
  _options: ToolRenderResultOptions,
  theme: Theme,
): string | undefined {
  const loaded = result.details?.deterministicDocs?.loaded ?? [];
  if (loaded.length === 0) return undefined;

  return loaded.map((entry) => `${theme.fg("success", "loaded:")} ${theme.fg("accent", entry.path)}`).join("\n");
}

export function renderDeterministicDocsSummary(
  result: { details?: DeterministicDocsReadDetails },
  options: ToolRenderResultOptions,
  theme: Theme,
): Text | undefined {
  const text = formatDeterministicDocsSummary(result, options, theme);
  return text ? new Text(text, 0, 0) : undefined;
}
