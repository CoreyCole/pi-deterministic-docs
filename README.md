# pi-deterministic-docs

A Pi extension that makes project documentation loading deterministic.

When the model reads a file, the extension finds the nearest documentation files on the path to that file and injects any not-yet-seen docs into the same tool result. This keeps the model aligned with local project instructions without relying on it to remember to read them first.

## What it loads

For each directory from filesystem root to the read target's directory, the extension loads the first matching file by priority:

1. `AGENTS.md`
1. `CLAUDE.md`
1. `README.md` or `readme.md`

Each doc is loaded once per session branch and content hash. If a doc changes, it is loaded again with the new hash.

## Why deterministic

- Docs are selected by a fixed ancestor walk and priority order.
- Loaded docs are persisted in the Pi session via custom entries.
- Concurrent `read` tool calls use a single-flight guard, so the same doc is not injected multiple times in one parallel tool batch.
- Explicitly reading a doc returns that file normally and does not prepend the same doc as hidden context.

## Install

```bash
pi install git:git@github.com:CoreyCole/pi-deterministic-docs.git
```

Then restart Pi or run:

```text
/reload
```

## Usage

No commands are required. The package listens for `read` tool results and patches them with deterministic docs context. It does not register, override, or render the `read` tool, so another extension can own `read` rendering or execution.

Example rendered output from a compatible renderer:

```text
read src/foo.ts
loaded: /repo/AGENTS.md
loaded: /repo/packages/app/AGENTS.md
```

The `loaded:` lines indicate docs that were injected into the tool result sent to the model.

## Notes

- If you want visible `loaded:` summaries, use a renderer that reads `details.deterministicDocs.loaded` from patched read results and hides `details.deterministicDocs.autoContextContentBlocks` from the visible result.
- Extensions run with your local user permissions. Review package source before installing third-party Pi packages.
