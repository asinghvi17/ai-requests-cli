// Temp directories and file trees for submit tests.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const dirs: string[] = [];

export function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'air-submit-test-'));
  dirs.push(d);
  return d;
}

export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Writes `files` (relative path -> contents) under a fresh temp dir and returns it. */
export function tree(files: Record<string, string | Buffer>): string {
  const root = tmp();
  for (const [rel, data] of Object.entries(files)) {
    const p = join(root, ...rel.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  }
  return root;
}

// Token-shaped strings are built at run time so this repo's own sources don't look like they hold secrets.
export const FAKE = {
  ghp: 'gh' + 'p_' + 'A1b2C3d4'.repeat(4) + 'XyZ0',
  pat: 'github' + '_pat_' + '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
  sk: 's' + 'k-' + 'proj-' + 'q'.repeat(30),
  akia: 'AK' + 'IA' + 'QWERTYUIOPASDFGH',
  pem: '-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n',
};
