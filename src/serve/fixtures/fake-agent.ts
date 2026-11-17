// Stands in for claude/codex in tests and smoke runs. It reads AIR_TASK.md for a line `FAKE: <mode> [arg]`,
// does what the mode says, creates AIR_DONE and then idles like an interactive agent until interrupted.
// Every start appends its argv to agent-argv.log in the workspace.
//   comment TEXT   write TEXT to out/REPORT.md      big N     write an N-character report
//   pr [PATH...]   commit a change in repo/PATH (default: every repo under repo/)
//   nopr           commit nothing
//   prhostile URL  commit, and plant a pre-push hook and a pushurl elsewhere in each repo's .git/config
//   artifact       write files to out/              empty     write nothing to out/
//   wait           wait for the file `go`, then report "resumed"
//   exit N         exit N at once                   hang      never finish
//   exitdone       wait for the file `go`, then report "finished", create AIR_DONE and exit 0 at once
//   quit N         note the start in out/PROGRESS.md (and commit a WIP change on branch `work` in every repo),
//                  then exit N after 700 ms without creating AIR_DONE
//   progress       write out/PROGRESS.md, then never finish
//   prompt NAME    show the captured prompt screen fixtures/panes/NAME.txt until the file `go` exists, then
//                  clear the screen, report "answered" and create AIR_DONE
//   screen NAME    never finish; show fixtures/panes/NAME.txt while the file `screen` is missing or says
//                  `prompt`, and "working <n>" (n counting up) otherwise
// A start with --resume (or `resume`) exits 3 at once if the file `resume-fails` exists.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ws = process.env.AIR_WORKSPACE ?? process.cwd();
const argv = process.argv.slice(2);
appendFileSync(join(ws, 'agent-argv.log'), `${JSON.stringify(argv)}\n`);
if ((argv.includes('--resume') || argv[0] === 'resume') && existsSync(join(ws, 'resume-fails'))) process.exit(3);

const task = readFileSync(join(ws, 'AIR_TASK.md'), 'utf8');
const [, mode = 'comment', arg = ''] = /^FAKE: (\S+) ?(.*)$/m.exec(task) ?? [];
const out = join(ws, 'out');
const report = (s: string) => writeFileSync(join(out, 'REPORT.md'), s);
const done = () => writeFileSync(join(ws, 'AIR_DONE'), '');
const idle = () => setInterval(() => {}, 1 << 30);
console.log(`fake agent: ${mode} ${arg}`);

const git = (repo: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=agent', '-c', 'user.email=agent@example.com', ...a], { cwd: repo, encoding: 'utf8' });
/** Every checkout under repo/ (a folder holding `.git`), as a path under repo/. */
function repos(dir = join(ws, 'repo'), rel = ''): string[] {
  if (!existsSync(dir)) return [];
  if (existsSync(join(dir, '.git'))) return [rel];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => repos(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name));
}

if (mode === 'exit') process.exit(Number(arg));
if (mode === 'hang') idle();
else if (mode === 'progress') {
  writeFileSync(join(out, 'PROGRESS.md'), 'half done\n');
  idle();
} else if (mode === 'quit') {
  const start = readFileSync(join(ws, 'agent-argv.log'), 'utf8').trim().split('\n').length;
  appendFileSync(join(out, 'PROGRESS.md'), `start ${start}\n`);
  for (const r of repos()) {
    const repo = join(ws, 'repo', r);
    if (git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim() !== 'work') git(repo, 'checkout', '-q', '-b', 'work');
    writeFileSync(join(repo, `WIP-${start}`), 'wip\n');
    git(repo, 'add', `WIP-${start}`);
    git(repo, 'commit', '-q', '-m', `wip ${start}`);
  }
  setTimeout(() => process.exit(Number(arg)), 700);
}
else if (mode === 'exitdone') {
  const t = setInterval(() => {
    if (!existsSync(join(ws, 'go'))) return;
    clearInterval(t);
    report('finished');
    done();
    process.exit(0);
  }, 50);
}
else if (mode === 'prompt') {
  process.stdout.write(readFileSync(new URL(`panes/${arg}.txt`, import.meta.url), 'utf8'));
  const t = setInterval(() => {
    if (!existsSync(join(ws, 'go'))) return;
    clearInterval(t);
    process.stdout.write('\x1b[2J\x1b[Hanswered; working\n');
    report('answered');
    done();
    idle();
  }, 50);
}
else if (mode === 'screen') {
  const prompt = readFileSync(new URL(`panes/${arg}.txt`, import.meta.url), 'utf8');
  let shown = '';
  let n = 0;
  setInterval(() => {
    const want = existsSync(join(ws, 'screen')) ? readFileSync(join(ws, 'screen'), 'utf8').trim() : 'prompt';
    const text = want === 'prompt' ? prompt : `working ${++n}\n`;
    if (text !== shown) process.stdout.write(`\x1b[2J\x1b[H${text}`);
    shown = text;
  }, 50);
}
else if (mode === 'wait') {
  const t = setInterval(() => {
    if (!existsSync(join(ws, 'go'))) return;
    clearInterval(t);
    report('resumed');
    done();
    idle();
  }, 50);
} else {
  if (mode === 'comment') report(arg);
  if (mode === 'big') report('x'.repeat(Number(arg)));
  if (mode === 'pr' || mode === 'nopr' || mode === 'prhostile') {
    const paths = mode === 'pr' && arg ? arg.split(' ') : repos();
    for (const r of paths) {
      const repo = join(ws, 'repo', r);
      git(repo, 'checkout', '-q', '-b', 'work');
      if (mode !== 'nopr') {
        writeFileSync(join(repo, 'CHANGE'), 'changed\n');
        git(repo, 'add', 'CHANGE');
        git(repo, 'commit', '-q', '-m', 'the change');
      }
      if (mode === 'prhostile') {
        const hook = join(repo, '.git', 'hooks', 'pre-push');
        writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(join(ws, 'hook-ran'))}\n`, { mode: 0o755 });
        git(repo, 'config', 'remote.origin.pushurl', arg);
        git(repo, 'config', 'core.fsmonitor', `touch ${join(ws, 'fsmonitor-ran')}`);
      }
    }
    report('Adds CHANGE.');
  }
  if (mode === 'artifact') {
    mkdirSync(join(out, 'sub'));
    writeFileSync(join(out, 'a.txt'), 'alpha\n');
    writeFileSync(join(out, 'sub', 'b.txt'), 'beta\n');
    symlinkSync('/etc/passwd', join(out, 'link'));
  }
  if (mode === 'empty') symlinkSync('/etc/passwd', join(out, 'only-a-link'));
  done();
  idle();
}
