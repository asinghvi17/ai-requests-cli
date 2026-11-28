// `air debug panes`: what tmux reports and what air makes of it, to diagnose a job whose window air cannot see.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ServeContext } from './context.ts';
import { clientEnv } from './tmux/env.ts';
import { socketPath } from './tmux/tmux.ts';
import { allWorkspaces, ENDED } from './workspace-state.ts';

/** Writes the diagnosis to `out`, a line at a time. Rows are JSON strings so tabs show as \\t (a `_` in their place is the locale bug). */
export async function debugPanes(ctx: ServeContext, out: (line: string) => void): Promise<void> {
  const env = clientEnv();
  const version = spawnSync('tmux', ['-V'], { env, encoding: 'utf8' });
  out(`tmux: ${(version.stdout ?? '').trim() || `not runnable (${version.error?.message ?? version.stderr})`}`);
  out(`socket: ${socketPath(ctx.tmux.socket)} (-L ${ctx.tmux.socket}), session ${ctx.tmux.session}`);
  out(`client locale: LC_ALL=${JSON.stringify(process.env.LC_ALL ?? '')} LC_CTYPE=${JSON.stringify(process.env.LC_CTYPE ?? '')} LANG=${JSON.stringify(process.env.LANG ?? '')}`);
  const raw = await ctx.tmux.listPanesRaw();
  out(`format: ${JSON.stringify(raw.format)}`);
  out(`list-panes -a, as air runs it (tmux -u): exit ${raw.code}${raw.stderr.trim() ? `, stderr ${JSON.stringify(raw.stderr.trim())}` : ''}`);
  for (const line of raw.stdout.split('\n').filter(Boolean)) out(`  ${JSON.stringify(line)}`);
  const plain = spawnSync('tmux', ['-L', ctx.tmux.socket, 'list-panes', '-a', '-F', raw.format], { env, encoding: 'utf8' });
  out(`list-panes -a without -u (the old way): exit ${plain.status}`);
  for (const line of (plain.stdout ?? '').split('\n').filter(Boolean)) out(`  ${JSON.stringify(line)}`);
  let jobs: Awaited<ReturnType<ServeContext['tmux']['listJobs']>> = [];
  try {
    jobs = await ctx.tmux.listJobs();
    out(`jobs air parses: ${jobs.length}`);
    for (const j of jobs) out(`  #${j.issue} nonce ${j.nonce} window ${j.windowId} pane ${j.paneId} agent pid ${j.pid} (group ${j.panePid}) ${j.dead ? `dead (status ${j.exitStatus ?? '-'}, signal ${j.exitSignal ?? '-'})` : 'alive'}`);
  } catch (e) {
    out(`jobs air parses: listJobs failed: ${(e as Error).message}`);
  }
  const held = allWorkspaces(ctx.root, ctx.gh.repo).filter((w) => w.state.job && !ENDED.includes(w.state.job.status));
  out(`jobs air holds (${ctx.root}): ${held.length}`);
  for (const { dir, state } of held) {
    const job = state.job!;
    const found = jobs.find((j) => j.issue === state.issue && j.nonce === job.paneNonce);
    out(`  #${state.issue} ${state.phase}/${job.status} paneNonce ${job.paneNonce ?? '(none)'}: ${found ? `window ${found.windowId}` : 'NO MATCHING PANE'}${existsSync(join(dir, 'AIR_DONE')) ? ', AIR_DONE present' : ''} (${dir})`);
  }
}
