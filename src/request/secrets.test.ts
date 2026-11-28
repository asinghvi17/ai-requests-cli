import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { allowed, findSecrets } from './secrets.ts';
import { FAKE, cleanup, tree } from './testing/submit.ts';

after(cleanup);

test('flags secret-looking files by name, by credential config and by content', () => {
  const files: Record<string, string> = {
    'README.md': 'nothing here: sk-short, AKIA, ghp_',
    'src/app.ts': 'const x = 1;',
    '.env': 'A=1',
    '.env.local': 'A=1',
    'certs/server.pem': 'x',
    'tls.key': 'x',
    'home/id_rsa': 'x',
    'home/id_ed25519.pub': 'x',
    'credentials.json': '{}',
    '.aws/config': '[default]',
    '.config/gcloud/application_default_credentials.json': '{}',
    '.npmrc': `//registry.npmjs.org/:_authToken=${FAKE.ghp}\n`,
    'clean/.npmrc': 'registry=https://registry.npmjs.org/\n',
    '.pypirc': '[pypi]\nusername = __token__\npassword = pypi-xyz\n',
    'clean/.pypirc': '[distutils]\nindex-servers = pypi\n',
    'notes/ghp.txt': `token ${FAKE.ghp}`,
    'notes/pat.txt': FAKE.pat,
    'notes/sk.txt': `OPENAI=${FAKE.sk}`,
    'notes/aws.txt': `key=${FAKE.akia}`,
    'notes/key.txt': FAKE.pem,
    // A token straddling the 1 MiB read boundary is still found.
    'big.txt': `${'x'.repeat((1 << 20) - 10)}${FAKE.ghp}`,
  };
  const root = tree(files);
  const found = findSecrets(root, Object.keys(files));
  const byPath = Object.fromEntries(found.map((f) => [f.path, f.reason]));
  assert.deepEqual(Object.keys(byPath).sort(), [
    '.aws/config', '.config/gcloud/application_default_credentials.json', '.env', '.env.local', '.npmrc', '.pypirc', 'big.txt',
    'certs/server.pem', 'credentials.json', 'home/id_ed25519.pub', 'home/id_rsa', 'notes/aws.txt', 'notes/ghp.txt', 'notes/key.txt',
    'notes/pat.txt', 'notes/sk.txt', 'tls.key',
  ]);
  assert.match(byPath['notes/ghp.txt']!, /GitHub token/);
  assert.match(byPath['notes/key.txt']!, /private key/);
  // Reasons never quote the matched text.
  for (const r of Object.values(byPath)) for (const s of Object.values(FAKE)) assert.ok(!r.includes(s.slice(0, 12)));
});

test('--allow-file covers a path or a directory', () => {
  assert.ok(allowed('.env', ['.env']));
  assert.ok(allowed('.env', ['./.env']));
  assert.ok(allowed('.aws/config', ['.aws/']));
  assert.ok(allowed('.aws/config', ['.aws']));
  assert.ok(!allowed('.awsx/config', ['.aws']));
  assert.ok(!allowed('.env.local', ['.env']));
});
