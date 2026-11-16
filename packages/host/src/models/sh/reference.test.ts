// Replays fixtures/reference/container-shell/cases.json (real dash, BusyBox ash and bash running
// `sh -c` scripts in a container's clean environment) against the container shell model.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { Executable, ModelStep, ProcessInput } from '../types.ts';
import { resumeShell, startShell } from './run.ts';

interface Result {
  stdout: string;
  stderr: string;
  status: number;
}
interface Case {
  script: string;
  args: string[];
  dash: Result;
  busybox: Result;
  bash: Result;
}

const data = JSON.parse(readFileSync(new URL('../../../../../fixtures/reference/container-shell/cases.json', import.meta.url), 'utf8')) as { env: Record<string, string>; cases: Case[] };
const UTILS = ['sleep', 'env', 'printenv', 'cat', 'date', 'hostname', 'true', 'false', 'echo', 'printf'];

export function run(shell: 'dash' | 'busybox' | 'bash', script: string, args: string[] = []): Result & { gaps: string[] } {
  const variant = shell === 'busybox' ? 'busybox' : 'gnu';
  const which = (name: string): Executable | undefined => {
    const base = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
    if (!UTILS.includes(base)) return undefined;
    const path = name.includes('/') ? name : `/bin/${name}`;
    if (name.includes('/') && path !== `/bin/${base}` && path !== `/usr/bin/${base}`) return undefined;
    return { path, model: base, variant };
  };
  const arg0 = shell === 'bash' ? 'bash' : 'sh';
  let now = 0;
  const input = (): ProcessInput => ({
    argv: [arg0, '-c', script, ...args],
    env: Object.entries(data.env),
    exe: { path: '/bin/sh', model: 'sh', variant: shell },
    pid: 1,
    init: true,
    hostname: 'web',
    cpus: 2,
    now,
    which,
    file: () => undefined,
  });
  let step: ModelStep = startShell(input());
  let stdout = '';
  let stderr = '';
  const gaps: string[] = [];
  for (let i = 0; i < 1000; i++) {
    for (const o of step.output ?? []) {
      if (o.stream === 'stdout') stdout += o.text;
      else stderr += o.text;
    }
    gaps.push(...(step.gaps ?? []).map((g) => g.what));
    const n = step.next;
    if ('exit' in n) return { stdout, stderr, status: n.exit, gaps };
    if ('wake' in n) {
      now += n.wake;
      step = resumeShell(input(), n.state);
      continue;
    }
    return { stdout, stderr, status: -1, gaps };
  }
  throw new Error('no exit');
}

describe.each(['dash', 'busybox', 'bash'] as const)('%s', (shell) => {
  test.each(data.cases.map((c) => [c.script, c] as const))('%s', (_script, c) => {
    const r = run(shell, c.script, c.args);
    expect(r.gaps).toEqual([]);
    expect({ stdout: r.stdout, stderr: r.stderr, status: r.status }).toEqual(c[shell]);
  });
});
