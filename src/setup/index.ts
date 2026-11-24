// The setup domain (docs/architecture.md): what other domains import from it.
export { configPath, loadConfig, parseConfig, type Config } from '../config.ts';
export { hostOs, installHint, LOGIN_HINT, OS_NAMES, type Os } from '../serve/hints.ts';
export {
  airOnPath, configState, defaultPreflightDeps, fixOf, formatPreflight, ghState, gitVersion, loginsOf, preflight, refusals,
  workspaceRootProblem, type AgentCheck, type GhState, type Login, type Problem,
} from '../serve/preflight.ts';
