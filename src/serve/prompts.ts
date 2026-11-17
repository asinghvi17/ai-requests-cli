// Is a running agent waiting on a person? Each `air serve` tick reads the visible screen of the job's pane
// (`tmux capture-pane -p`) and matches its last lines against the prompts below; a screen that has not
// changed for STUCK_MS counts as a possible prompt too. The patterns are the CLIs' own prompt text: each
// entry says where it came from. "captured" ones are in src/serve/fixtures/panes/, taken from the CLI
// running in tmux with a fresh config dir; "binary" ones are strings in the CLI's executable whose screen
// could not be produced without a working login.
import type { Harness } from './agent.ts';

export interface PromptPattern {
  harness: Harness;
  id: string;
  /** What the agent is waiting for, for the log, `air status` and the issue comment. */
  what: string;
  /** Every one must match the screen's last lines. */
  match: RegExp[];
  /** How to stop it happening again, or `attach` when only answering it helps. */
  fix: 'attach' | ((c: FixContext) => string);
  source: string;
}

export interface FixContext {
  /** air's config file. */
  configFile: string;
  workspaceRoot: string;
}

export interface Waiting {
  /** Pattern id, or `idle` for an unchanged screen. */
  prompt: string;
  what: string;
  /** The exact fix, with the attach command filled in. */
  fix: string;
}

/** A screen unchanged this long is taken for an agent waiting at a prompt. */
export const STUCK_MS = 5 * 60_000;
/** How many of the screen's last non-blank lines the patterns look at: prompts sit at the bottom. */
export const PROMPT_LINES = 30;

const CLAUDE = 'Claude Code 2.1.311';
const CODEX = 'Codex CLI 0.164.0';

const onboarding = (c: FixContext) =>
  `run \`mkdir -p ${c.workspaceRoot} && cd ${c.workspaceRoot} && claude\` once by hand, finish the first-run screens and log in, then answer "Yes, I trust this folder" (\`air doctor\` checks it)`;

export const PROMPTS: PromptPattern[] = [
  {
    harness: 'claude', id: 'claude-onboarding', what: 'Claude Code first-run onboarding (theme picker)',
    match: [/Choose the text style that looks best with your terminal/],
    fix: onboarding, source: `${CLAUDE}, captured: claude-onboarding.txt (empty CLAUDE_CONFIG_DIR)`,
  },
  {
    harness: 'claude', id: 'claude-login', what: 'Claude Code login method',
    match: [/Select login method:/],
    fix: onboarding, source: `${CLAUDE}, binary: "Select login method:"`,
  },
  {
    harness: 'claude', id: 'claude-trust', what: 'Claude Code folder trust ("Quick safety check")',
    match: [/Is this a project you created or one you trust\?/i, /Yes, I trust this folder/],
    fix: (c) => `run \`mkdir -p ${c.workspaceRoot} && cd ${c.workspaceRoot} && claude\`, answer "Yes, I trust this folder", then /exit (folders below it inherit the trust)`,
    source: `${CLAUDE}, captured: claude-trust.txt (onboarded config, untrusted folder)`,
  },
  {
    harness: 'claude', id: 'claude-bypass-confirm', what: 'Claude Code Bypass Permissions warning',
    match: [/WARNING: Claude Code running in Bypass Permissions mode/, /Yes, I accept/],
    fix: (c) => `use auto mode: args = ["--permission-mode", "auto"] under [agents.claude] in ${c.configFile}; or run \`claude --permission-mode bypassPermissions\` once by hand and choose "Yes, I accept"`,
    source: `${CLAUDE}, captured: claude-bypass.txt (--permission-mode bypassPermissions)`,
  },
  {
    harness: 'claude', id: 'claude-auto-mode-dialog', what: 'a Claude Code auto mode dialog',
    match: [/Teach auto mode about your environment\?|Make auto mode your default permission mode\?/],
    fix: 'attach', source: `${CLAUDE}, binary: "Teach auto mode about your environment?", "Make auto mode your default permission mode?"`,
  },
  {
    // Auto mode asks a person again after repeated classifier denials, or when its check is unavailable.
    harness: 'claude', id: 'claude-permission', what: 'a Claude Code permission prompt',
    match: [/Do you want to (proceed|make this edit|create|allow|use this|continue)\b/, /Esc to cancel/],
    fix: (c) => `attach and answer it; if it recurs, check args under [agents.claude] in ${c.configFile} include "--permission-mode", "auto"`,
    source: `${CLAUDE}, binary: "Do you want to proceed", "Yes, and don't ask again for", "Esc to cancel"`,
  },
  {
    harness: 'codex', id: 'codex-login', what: 'Codex sign-in',
    match: [/Welcome to Codex/, /Sign in with ChatGPT/],
    fix: () => 'run `codex login` (with the login\'s CODEX_HOME, if it sets one)',
    source: `${CODEX}, captured: codex-login.txt (empty CODEX_HOME)`,
  },
  {
    harness: 'codex', id: 'codex-trust', what: 'Codex folder trust ("Trust this folder?")',
    match: [/Trust this folder\?/, /Trust and continue/],
    fix: (c) => `run \`air doctor\`: it names the repo to trust in Codex's config.toml (workspace_root ${c.workspaceRoot} is inside a git repo)`,
    source: `${CODEX}, captured: codex-trust.txt (a git repo, with and without -a never -s workspace-write)`,
  },
  {
    harness: 'codex', id: 'codex-approval', what: 'a Codex approval request',
    match: [/Would you like to (run the following command|make the following edits|grant these permissions|send input to the existing terminal)\?|Approve app tool call\?/],
    fix: (c) => `attach and answer it; to stop it recurring, set args = ["--ask-for-approval", "never", ...] under [agents.codex] in ${c.configFile} (\`air config init --print\` shows the default)`,
    source: `${CODEX}, binary: "Would you like to run the following command?", "Would you like to make the following edits?", "Would you like to grant these permissions?", "Approve app tool call?"`,
  },
];

/** The screen's last PROMPT_LINES non-blank lines as one line, whitespace collapsed: a narrow pane wraps prompts. */
function bottom(screen: string): string {
  return screen.split('\n').filter((l) => l.trim() !== '').slice(-PROMPT_LINES).join(' ').replace(/\s+/g, ' ');
}

/** The known prompt `screen` ends on, for `harness`. */
export function matchPrompt(harness: Harness, screen: string): PromptPattern | undefined {
  const text = bottom(screen);
  return PROMPTS.find((p) => p.harness === harness && p.match.every((re) => re.test(text)));
}

/**
 * What to tell the volunteer about `p`: its fix, or how to attach and answer. `attach` is the formatted
 * commands that attach to the job's window, e.g. `` `air attach 12` ``.
 */
export function waitingFor(p: PromptPattern | 'idle', c: FixContext & { attach: string }): Waiting {
  const attach = `attach with ${c.attach} and answer it`;
  if (p === 'idle') {
    return { prompt: 'idle', what: `no screen change for ${STUCK_MS / 60_000} min: it may be waiting at a prompt`, fix: attach };
  }
  return { prompt: p.id, what: p.what, fix: p.fix === 'attach' ? attach : p.fix(c).replace(/^attach and answer it/, attach) };
}
