# Conventions

- TypeScript on Node >= 26, run directly (type stripping): no build step for dev. Only erasable syntax
  (no enums, namespaces or parameter properties); import local files with their `.ts` extension.
- Zero runtime dependencies. devDependencies (typescript, @types/node, build tools) are fine.
- All GitHub access goes through the user's `gh` CLI (`src/gh/`). Never read, store or log a token, and
  don't pass credentials into child environments that don't need them. The agent is the exception: it
  inherits the volunteer's whole environment (`src/server/tmux/env.ts`).
- Tests are `*.test.ts` next to their sources, using `node:test` and `node:assert/strict`.
  `npm test` = typecheck + `node --test`.

## Layout

| Path | Contents |
| --- | --- |
| `src/cli/` | entry point (`main.ts`) and one module per command: argument parsing, dispatch and output; the logic is in the domains, through their `index.ts` |
| `src/setup/` | a volunteer's machine: config loading with the models and tiers (`config.ts`), the startup checks `air serve` runs and `air doctor` reports (`preflight.ts`, gathered for doctor in `doctor.ts`), the install command for each OS (`hints.ts`), and the setup `air serve` and `air skill install` do on first run (`firstrun.ts`: gh login, config, folder trust); other domains import it through `index.ts` |
| `src/request/` | the request as GitHub sees it: front-matter parser and lint, markers, labels, trust rule, context zips; `air submit` (file collection, secrets check, the template filled in from prompts in `template.ts`), `air sweep`, the requester's side (`air status`, `wait`, `fetch`, `retry`, `cancel`), and `air skill install` under `skill/` (`bundle.ts`, generated); other domains import it through `index.ts` |
| `src/agents/` | the coding agents: command lines and the task handoff (`harness.ts`), the launch environment, waiting-prompt detection (`prompts.ts`) with captured screens under `fixtures/panes/`, Claude Code folder trust (`claude-trust.ts`), and the subscription usage readers and prices under `usage/`; other domains import it through `index.ts` |
| `src/gh/` | `gh api` wrapper; typed issue/comment/label calls (`issues.ts`), release assets and repo-wide listings (`releases.ts`), in-memory fakes for tests under `testing/`; other domains import it through `index.ts` |
| `src/server/` | `air serve`, flat: the loop (`server.ts`) and its lifecycle (`run.ts`: tmux window, serve lock, signals), the serve context, the serve lock and state (`state.ts`), effort matching against local quota (`match.ts`), the claim race and release (`claim.ts`, `repos.ts`), per-job workspace setup, state, task and teardown (`workspace-*.ts`, `task.ts`), the job lifecycle (`jobs.ts`: start, stop, resume, finish), delivery (`deliver.ts`, `github.ts`), cleanup (`tidy.ts`), `air debug panes` (`debug.ts`), and tmux control on the private `air` socket under `tmux/`; other domains import it through `index.ts` |
| `skills/ai-request/` | the Claude Code skill's source; `npm run skill:bundle` regenerates `src/request/skill/bundle.ts` after edits |
| `docs/architecture.md` | the target module layout and its import rules, enforced by `src/boundaries.test.ts` |
| `docs/decisions.md` | decision log: append, newest last |
| `src/lib/` | shared code with no air knowledge (docs/architecture.md): TOML-subset parser, version, air's config and state dirs (`dirs.ts`), a command's output and `CommandError`, pid and lock files, setup exec, git (resolve, clone, checkpoint), zip reader and writers |
| `scripts/` | dev tooling: `typecheck.ts`, `build.ts` (Bun single executables into `dist/`, not committed), `bundle-skill.ts`, `move.ts` (moves files and rewrites imports), `boundaries.ts` (the check behind `src/boundaries.test.ts`) |
