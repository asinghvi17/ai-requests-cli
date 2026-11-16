// Stands in for claude/codex in tests and smoke runs. It reads AIR_TASK.md for a line `FAKE: <mode> [arg]`,
// does what the mode says, creates AIR_DONE and then idles like an interactive agent until interrupted.
// Every start appends its argv to agent-argv.log in the workspace.
//   comment TEXT   write TEXT to out/REPORT.md      big N     write an N-character report
//   pr             commit a change in repo/         nopr      commit nothing
//   prhostile      commit, and plant a pre-push hook and a pushurl elsewhere in repo/.git/config
//   artifact       write files to out/              empty     write nothing to out/
//   wait           wait for the file `go`, then report "resumed"
//   exit N         exit N at once                   hang      never finish
//   exitdone       wait for the file `go`, then report "finished", create AIR_DONE and exit 0 at once
//   quit N         note the start in out/PROGRESS.md (and, with repo/, commit a WIP change on branch `work`),
//                  then exit N after 700 ms without creating AIR_DONE
//   progress       write out/PROGRESS.md, then never finish
// A start with --resume (or `resume`) exits 3 at once if the file `resume-fails` exists.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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

const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=agent', '-c', 'user.email=agent@example.com', ...a], { cwd: join(ws, 'repo'), encoding: 'utf8' });

if (mode === 'exit') process.exit(Number(arg));
if (mode === 'hang') idle();
else if (mode === 'progress') {
  writeFileSync(join(out, 'PROGRESS.md'), 'half done\n');
  idle();
} else if (mode === 'quit') {
  const start = readFileSync(join(ws, 'agent-argv.log'), 'utf8').trim().split('\n').length;
  appendFileSync(join(out, 'PROGRESS.md'), `start ${start}\n`);
  if (existsSync(join(ws, 'repo'))) {
    if (git('rev-parse', '--abbrev-ref', 'HEAD').trim() !== 'work') git('checkout', '-q', '-b', 'work');
    writeFileSync(join(ws, 'repo', `WIP-${start}`), 'wip\n');
    git('add', `WIP-${start}`);
    git('commit', '-q', '-m', `wip ${start}`);
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
    const repo = join(ws, 'repo');
    git('checkout', '-q', '-b', 'work');
    if (mode !== 'nopr') {
      writeFileSync(join(repo, 'CHANGE'), 'changed\n');
      git('add', 'CHANGE');
      git('commit', '-q', '-m', 'the change');
    }
    if (mode === 'prhostile') {
      const hook = join(repo, '.git', 'hooks', 'pre-push');
      writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(join(ws, 'hook-ran'))}\n`, { mode: 0o755 });
      git('config', 'remote.origin.pushurl', arg);
      git('config', 'core.fsmonitor', `touch ${join(ws, 'fsmonitor-ran')}`);
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
