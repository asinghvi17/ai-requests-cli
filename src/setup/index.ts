// The setup domain (docs/architecture.md): what other domains import from it.
export { configPath, DEFAULT_AGENTS, loadConfig, parseConfig, type Config } from './config.ts';
export { ensureConfig, ensureGh, firstRunDeps, fixTrust } from './firstrun.ts';
export { hostOs, installHint, LOGIN_HINT, OS_NAMES, type Os } from './hints.ts';
export {
  airOnPath, configState, defaultPreflightDeps, fixOf, formatPreflight, ghState, gitVersion, loginsOf, preflight, refusals,
  workspaceRootProblem, type AgentCheck, type GhState, type Login, type Problem,
} from './preflight.ts';
