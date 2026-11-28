// Test teardown: what of a throwaway tmux server's panes outlived it. tmux puts TMUX=<socket path>,<server
// pid>,<session> in the environment of every process it forks for a pane, and its children inherit it, so a
// process that still holds one of the server's ptys after the server is gone is found by its environment.
// Each keeps a pty (macOS has 511): startJob's old placeholder leaked one in about one start in five there.
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

/** Pids of the live processes whose environment has TMUX naming socket `socket`. */
export function paneProcesses(socket: string): number[] {
  // ps shows the environment after the command: `-E` on macOS (where `-e` is every process), `e` elsewhere.
  const args = process.platform === 'darwin' ? ['-AEww', '-o', 'pid=,stat=,command='] : ['axeww', '-o', 'pid=,stat=,args='];
  const ps = spawnSync('ps', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const tag = new RegExp(`(^|\\s)TMUX=\\S*/${socket.replace(/[^\w-]/g, '\\$&')},\\d+,\\d+(\\s|$)`);
  return ps.stdout.split('\n').map((l) => l.trim().split(/\s+/))
    .filter(([pid, stat, ...rest]) => pid && stat && !stat.startsWith('Z') && Number(pid) !== process.pid && tag.test(rest.join(' ')))
    .map(([pid]) => Number(pid));
}

/**
 * Wait up to `ms` (a launcher's reaper may still be on its way out) for every process of socket `socket`'s
 * panes to exit. Those left are KILLed, so a failing check leaks nothing either, and returned as
 * `<pid> <command>` lines (no environment: it is the caller's, secrets and all).
 */
export async function leftoverPaneProcesses(socket: string, ms = 6000): Promise<string[]> {
  const end = Date.now() + ms;
  let left = paneProcesses(socket);
  while (left.length > 0 && Date.now() < end) {
    await sleep(100);
    left = paneProcesses(socket);
  }
  if (left.length === 0) return [];
  const ps = spawnSync('ps', ['-o', 'pid=,command=', '-p', left.join(',')], { encoding: 'utf8' });
  for (const pid of left) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  return ps.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}
