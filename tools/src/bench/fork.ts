// Measures fork, hash, snapshot and restore for a world of three Ubuntu machines with a few
// thousand files each (phase 01 exit criterion; results recorded in docs/ARCHITECTURE.md §2.7).
// Run: npm run bench:fork [-- --files N]

import { performance } from 'node:perf_hooks';
import { buildUbuntuBase, createFs, createMachine, hostPlugin, ROOT_CRED } from '@simlab/host';
import { bootKernel, createKernel, createRegistry, DEFAULT_START_TIME, restore, snapshot } from '@simlab/kernel';

const arg = process.argv.indexOf('--files');
const filesPerMachine = arg > 0 ? Number(process.argv[arg + 1]) : 3000;
const machines = ['controlplane', 'node01', 'node02'];

const registry = createRegistry([hostPlugin]);
const kernel = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME });
kernel.act('setup', (ctx) => {
  for (const id of machines) {
    createMachine(ctx, { id, hostname: id, kind: 'node' });
    buildUbuntuBase(ctx, id, { user: { name: 'student' } });
    const fs = createFs(ctx, id, { cred: ROOT_CRED, umask: 0o022 });
    const rnd = ctx.random('bench');
    // A plausible spread: package-style directories of 1–40 files, sizes from 100 B to 20 kB.
    fs.mkdir('/usr/share/doc');
    let made = 0;
    for (let pkg = 0; made < filesPerMachine; pkg++) {
      const dir = `/usr/share/doc/pkg${pkg}`;
      fs.mkdir(dir);
      const n = 1 + rnd.int(40);
      for (let f = 0; f < n && made < filesPerMachine; f++, made++) {
        fs.writeFile(`${dir}/file${f}`, rnd.chars(100 + rnd.int(20_000), 'abcdefghijklmnopqrstuvwxyz \n'));
      }
    }
  }
});

const inodes = machines.reduce(
  (sum, id) => sum + Object.keys((kernel.world.slices.host as { machines: Record<string, { vfs: { inodes: object } }> }).machines[id]!.vfs.inodes).length,
  0,
);

function time(label: string, runs: number, fn: () => void): void {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))]!.toFixed(2);
  console.log(`${label.padEnd(34)} median ${q(0.5).padStart(8)} ms   p90 ${q(0.9).padStart(8)} ms   (${runs} runs)`);
}

console.log(`world: ${machines.length} machines, ${inodes} inodes in total (${filesPerMachine} extra files each), Node ${process.version}`);
for (let i = 0; i < 20; i++) kernel.fork(); // warm up

time('fork', 200, () => void kernel.fork());
{
  // Cold hash: a fresh restore has no cached value hashes.
  const text = snapshot(kernel.world, registry);
  console.log(`snapshot size                      ${(text.length / 1e6).toFixed(1)} MB`);
  time('hash, cold (after restore)', 5, () => void createKernel(restore(text, registry), registry).hash());
  time('snapshot', 5, () => void snapshot(kernel.world, registry));
  time('restore', 5, () => void restore(text, registry));
}
kernel.hash();
time('hash, warm (nothing changed)', 50, () => void kernel.hash());
time('fork + write one file + hash', 100, () => {
  const f = kernel.fork();
  f.act('bench', (ctx) => createFs(ctx, 'node01', { cred: ROOT_CRED, umask: 0o022 }).writeFile('/tmp/x', 'changed'));
  f.hash();
});
