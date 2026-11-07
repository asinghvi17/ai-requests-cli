// Starts a grandchild in its own process group, writes the grandchild's pid to argv[2], then hangs: for run.ts's group kill.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.argv[2]!, String(g.pid));
setInterval(() => {}, 1000);
