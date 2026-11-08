# Conventions

- TypeScript on Node >= 26, run directly (type stripping): no build step for dev. Only erasable syntax
  (no enums, namespaces or parameter properties); import local files with their `.ts` extension.
- Zero runtime dependencies. devDependencies (typescript, @types/node, build tools) are fine.
- All GitHub access goes through the user's `gh` CLI (`src/gh/`). Never read, store or log a token, and
  don't pass credentials into child environments that don't need them.
- Tests are `*.test.ts` next to their sources, using `node:test` and `node:assert/strict`.
  `npm test` = typecheck + `node --test`.

## Layout

| Path | Contents |
| --- | --- |
| `src/cli/` | entry point (`main.ts`) and one module per command |
| `src/spec/` | request front-matter parser and lint |
| `src/usage/` | subscription usage readers (Claude, Codex) |
| `src/match/` | effort matching against local quota |
| `src/tmux/` | tmux control on the private `air` socket |
| `src/gh/` | `gh api` wrapper; typed issue/comment/label calls (`issues.ts`), release assets and repo-wide listings (`releases.ts`), and in-memory fakes for tests |
| `src/claim/` | claim markers in action: trust rule, claim race, release |
| `src/workspace/` | workspace setup and teardown |
| `src/submit/` | `air submit`: file collection (`.gitignore`), secrets check, zip writer |
| `src/sweep/` | `air sweep`: expired release assets |
| `docs/decisions.md` | decision log: append, newest last |
| `src/config.ts`, `src/toml.ts` | config loading and the TOML-subset parser |
| `scripts/` | dev tooling: `typecheck.ts`, `build.ts` (Bun single executables into `dist/`, not committed) |
