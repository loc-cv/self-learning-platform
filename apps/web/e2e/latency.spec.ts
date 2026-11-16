// Phase 10 exit criterion 3: typing latency is imperceptible and read commands answer within
// 50 ms at p95, measured in the browser from Enter to the prompt being back on screen (worker,
// message passing and xterm.js parsing; `painted` adds the next animation frame). Also run alone
// by `npm run bench:web`, which prints the table.

import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { openLab, run } from './workspace.ts';

const COMMANDS = [
  'kubectl get pods -A',
  'kubectl get nodes',
  'kubectl get deploy -A',
  'kubectl get svc -A',
  'kubectl get pods -A -o wide',
  'kubectl describe node node01',
  'kubectl get events -A',
  'kubectl -n kube-system get deploy coredns -o yaml',
  'ls -la /etc',
  'cat /etc/hostname',
];
const ROUNDS = 8;

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number;
};

test('read commands answer in under 50 ms at p95; keystrokes echo at once', async ({ page }) => {
  await openLab(page, 'k8s.troubleshooting.broken-rollout-01', 3);
  await run(page, 'clear');
  const samples = new Map<string, { parsed: number[]; painted: number[] }>(COMMANDS.map((c) => [c, { parsed: [], painted: [] }]));
  const keys: number[] = [];
  for (let round = 0; round <= ROUNDS; round++) {
    for (const command of COMMANDS) {
      keys.push(...(await page.evaluate((c) => window.__simlab.type(c), command)));
      const t = await page.evaluate(() => window.__simlab.enter());
      // The first round warms the JIT; it is not counted.
      if (round === 0) continue;
      const s = samples.get(command) as { parsed: number[]; painted: number[] };
      s.parsed.push(t.parsed);
      s.painted.push(t.painted);
    }
    await run(page, 'clear');
  }
  const rows = COMMANDS.map((command) => {
    const s = samples.get(command) as { parsed: number[]; painted: number[] };
    return { command, p50: pct(s.parsed, 50), p95: pct(s.parsed, 95), painted95: pct(s.painted, 95) };
  });
  const all = [...samples.values()].flatMap((s) => s.parsed);
  const allPainted = [...samples.values()].flatMap((s) => s.painted);
  const summary = { rounds: ROUNDS, samples: all.length, p50: pct(all, 50), p95: pct(all, 95), painted95: pct(allPainted, 95), keystroke: { p50: pct(keys, 50), p95: pct(keys, 95), samples: keys.length } };
  const ms = (x: number): string => `${x.toFixed(1).padStart(6)} ms`;
  const table = rows.map((r) => `${r.command.padEnd(52)} p50 ${ms(r.p50)}   p95 ${ms(r.p95)}   painted p95 ${ms(r.painted95)}`).join('\n');
  console.log(`${table}\n\nall read commands: p50 ${summary.p50.toFixed(1)} ms, p95 ${summary.p95.toFixed(1)} ms, painted p95 ${summary.painted95.toFixed(1)} ms (${summary.samples} samples)\nkeystroke echo: p50 ${summary.keystroke.p50.toFixed(1)} ms, p95 ${summary.keystroke.p95.toFixed(1)} ms (${summary.keystroke.samples} keys)`);
  writeFileSync('../../.tsbuild/playwright/latency.json', `${JSON.stringify({ summary, rows }, null, 2)}\n`);
  expect(summary.p95).toBeLessThan(50);
  expect(summary.keystroke.p95).toBeLessThan(16);
});
