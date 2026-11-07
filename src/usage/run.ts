import { execFile } from 'node:child_process';

/** A `.ts`/`.js` bin (a test fake) runs under this node; anything else is executed directly. */
export const command = (bin: string): [string, ...string[]] => /\.[cm]?[tj]s$/.test(bin) ? [process.execPath, bin] : [bin];

/** Run a CLI to completion with stdin closed; reject on non-zero exit or timeout. */
export function run(bin: string, args: string[], o: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number }): Promise<string> {
  const [file, ...pre] = command(bin);
  return new Promise((resolve, reject) => {
    const child = execFile(file, [...pre, ...args], { env: o.env, cwd: o.cwd, timeout: o.timeoutMs ?? 20000,
      maxBuffer: 1 << 20, killSignal: 'SIGKILL' }, (err, stdout) => err ? reject(err) : resolve(stdout));
    child.stdin?.end();
  });
}

/** Window name and kind from a length in minutes (Codex's `windowDurationMins`). */
export function windowOfMinutes(mins: number | null | undefined, fallback: string): { name: string; kind: string } {
  if (mins === 300) return { name: 'five_hour', kind: 'five_hour' };
  if (mins === 1440) return { name: 'one_day', kind: 'daily' };
  if (mins === 10080) return { name: 'seven_day', kind: 'weekly' };
  // calendar months are 28-31 days; Codex reports whole minutes
  if (mins && mins >= 28 * 1440 && mins <= 31 * 1440) return { name: 'monthly', kind: 'monthly' };
  return mins ? { name: `${mins}_min`, kind: `${mins}_min` } : { name: fallback, kind: fallback };
}

export const isoOrNull = (ms: number | null): string | null =>
  ms == null || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15 ? null : new Date(ms).toISOString();
