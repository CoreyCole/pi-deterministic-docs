# pi-deterministic-docs

This Pi extension adds project instructions to built-in `read` results.

The extension preserves the target result. It can add one leading text block that contains new instruction context.

## Instruction discovery

The extension resolves the current directory and the read target to canonical paths. The target must be a regular file inside the current directory.

For an eligible target, the extension examines each directory from the current directory to the target directory.

Each directory can supply one instruction file:

1. A regular `AGENTS.md` has first priority.
1. A regular `CLAUDE.md` is used only if `AGENTS.md` is absent.

The extension does not load `README.md` files. Reads outside the current directory do not receive inferred context.

Symlink and direct paths use the same canonical identity. Missing targets, directories, and paths that cannot be resolved do not start discovery.

## Observation state

An observation identity contains a canonical instruction path and its content hash. Each active session branch has independent observation state.

The extension stores branch observations as Pi custom entries. Tree navigation reconstructs state from the selected branch.

Pi startup context has separate observation state. The startup hash uses the exact content that Pi supplied to the system prompt.

A changed content hash creates a new observation identity. The extension can load that changed instruction again.

Parallel reads share one reservation coordinator. Only the transaction owner can add context or store an observation.

If a transaction fails, the extension removes its reservations. A waiting read can then load and store the required instruction.

## Explicit instruction reads

A complete explicit read has no `offset` or `limit`. It reserves its instruction identity before sibling tools start.

The explicit target remains in its original result. The extension adds only new ancestor instructions and never adds a second target copy.

A ranged instruction read is not a complete observation. It can still receive eligible ancestor context.

## Failure behavior

Required instruction loading is fail-closed. If one required instruction cannot load, the complete target transaction fails.

The error result contains no synthetic prefix and no successful target content. The extension stores no partial observations from that transaction.

An original target error does not start discovery or change observation state.

## Result metadata

A successful patched result keeps every original text and image block in its original order. One synthetic text block precedes those blocks.

The extension preserves existing `details` fields and adds these fields under `details.deterministicDocs`:

| Field | Meaning |
|---|---|
| `loaded` | Canonical instruction entries added by this transaction. |
| `skipped` | Canonical instruction paths that did not need another load. |
| `autoContextContentBlocks` | The exact number of synthetic leading content blocks. This value is `1` for a patched result. |

A renderer can remove the declared leading blocks from expanded output. It can also show `loaded` entries as compact summaries.

Reads without new context keep their original result unchanged.

## Install

Run this command:

```bash
pi install git:git@github.com:CoreyCole/pi-deterministic-docs.git
```

Then restart Pi or run `/reload`.

## Package ownership

This package listens to Pi events. It does not register, replace, or render the built-in `read` tool.

Another extension can own read rendering. That renderer must use `autoContextContentBlocks` instead of assuming one hidden block.

Extensions operate with local user permissions. Review third-party package source before installation.
