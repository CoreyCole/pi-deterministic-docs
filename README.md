# pi-deterministic-docs

A Pi extension that makes project documentation loading deterministic.

When the model reads a file, the extension finds the nearest documentation files on the path to that file and injects any not-yet-seen docs into the same tool result. This keeps the model aligned with local project instructions without relying on it to remember to read them first.

## What it loads

For each directory from filesystem root to the read target's directory, the extension loads the first matching file by priority:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `README.md` or `readme.md`

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

No commands are required. The package overrides Pi's built-in `read` tool and delegates to the original implementation after injecting deterministic docs when needed.

Example rendered output:

```text
read src/foo.ts
loaded: /repo/AGENTS.md
loaded: /repo/packages/app/AGENTS.md
```

The `loaded:` lines indicate docs that were injected into the tool result sent to the model.

## Notes

- Do not load this alongside another extension that overrides the `read` tool unless you intend one override to win.
- Extensions run with your local user permissions. Review package source before installing third-party Pi packages.
