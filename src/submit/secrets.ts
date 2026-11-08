// Refuses files that look like secrets before they go into a context zip. Checks names (`.env*`, keys,
// credential files, cloud config directories) and contents (common token formats). Findings name the file
// and the kind of match only: the matched text is never returned, so it can't be printed.
import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

export interface SecretFinding {
  path: string;
  reason: string;
}

const NAME_RULES: [RegExp, string][] = [
  [/^\.env(?:$|\.)|^\.envrc$/, 'environment file'],
  [/\.(?:pem|key|p12|pfx|jks|keystore|ppk|asc|gpg)$/i, 'key or certificate file'],
  [/^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[._-])/, 'SSH private key'],
  [/^credentials/i, 'credentials file'],
  [/^\.(?:netrc|git-credentials|pgpass)$|^_netrc$/, 'credentials file'],
  [/^(?:secrets?|service[-_]account)[^/]*\.(?:json|ya?ml|toml)$/i, 'credentials file'],
];

/** Directories whose contents are cloud or tool credentials, matched as path segments. */
const CONFIG_DIRS: [RegExp, string][] = [
  [/(?:^|\/)\.(?:aws|azure|ssh|gnupg|kube|docker|oci|terraform\.d)\//, 'cloud or tool config directory'],
  [/(?:^|\/)\.config\/(?:gcloud|gh|hub|doctl|op)\//, 'cloud or tool config directory'],
];

/** `.npmrc` and `.pypirc` are only flagged when they hold a credential. */
const TOKEN_CONFIGS: [RegExp, RegExp][] = [
  [/^\.npmrc$/, /_auth(?:Token)?\s*=|_password\s*=|\/\/[^\s]*:_/],
  [/^\.pypirc$/, /^\s*(?:password|token)\s*[=:]/m],
  [/^\.yarnrc(?:\.yml)?$/, /npmAuthToken|_authToken/],
];

const CONTENT_RULES: [RegExp, string][] = [
  [/gh[pousr]_[A-Za-z0-9]{36}/, 'GitHub token (gh*_)'],
  [/github_pat_[A-Za-z0-9_]{22,}/, 'GitHub fine-grained token (github_pat_)'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, 'API key (sk-)'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'AWS access key (AKIA)'],
  [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/, 'private key block'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack token (xox*-)'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, 'GitLab token (glpat-)'],
];

const CHUNK = 1 << 20;
const OVERLAP = 256;

function scanFile(file: string, rules: [RegExp, string][]): string | undefined {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(CHUNK + OVERLAP);
    let carry = 0;
    let pos = 0;
    for (;;) {
      const n = readSync(fd, buf, carry, CHUNK, pos);
      if (n === 0) return undefined;
      pos += n;
      const len = carry + n;
      const text = buf.toString('latin1', 0, len);
      for (const [re, reason] of rules) if (re.test(text)) return reason;
      // Keep the tail so a token split across two reads still matches.
      carry = Math.min(OVERLAP, len);
      buf.copy(buf, 0, len - carry, len);
    }
  } finally {
    closeSync(fd);
  }
}

/** The reason `rel` (a file under `root`) looks like a secret, or undefined. */
export function secretReason(root: string, rel: string): string | undefined {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  for (const [re, reason] of NAME_RULES) if (re.test(name)) return reason;
  for (const [re, reason] of CONFIG_DIRS) if (re.test(rel)) return reason;
  const file = join(root, ...rel.split('/'));
  for (const [nameRe, contentRe] of TOKEN_CONFIGS) {
    if (nameRe.test(name) && scanFile(file, [[contentRe, `${name} with a credential`]])) return `${name} with a credential`;
  }
  return scanFile(file, CONTENT_RULES);
}

/** Every file in `files` (relative to `root`) that looks like a secret. */
export function findSecrets(root: string, files: readonly string[]): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const path of files) {
    const reason = secretReason(root, path);
    if (reason) out.push({ path, reason });
  }
  return out;
}

/** Whether `--allow-file` values cover `path`: the path itself or one of its parent directories. */
export function allowed(path: string, allow: readonly string[]): boolean {
  return allow.some((a) => {
    const p = a.replace(/^\.\//, '').replace(/\/+$/, '');
    return p === path || path.startsWith(`${p}/`);
  });
}
