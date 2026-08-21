# Changelog

## [Unreleased]

### Added

- Initial Pi package release of Deterministic Docs.
- Added renderer metadata for loaded paths, skipped paths, and synthetic content-block counts.

### Changed

- Excluded skill reads from automatic instruction discovery.
- Limited instruction discovery to canonical read targets inside the current directory.
- Limited automatic context to `AGENTS.md` and `CLAUDE.md` instruction files.
- Made observation state follow the active Pi session branch and canonical content hash.
- Made complete explicit instruction reads and automatic reads use one transaction coordinator.

### Fixed

- Preserved original text and image blocks after one synthetic instruction-context block.
- Prevented duplicate context and state entries during parallel reads.
- Prevented partial observations when cancellation or required instruction loading causes an error.
- Prevented startup instruction content from loading again with the same hash.
