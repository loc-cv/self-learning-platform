// Test helpers: a ProcessInput over a small, hand-written file table standing for an image.

import { millisFromCivil } from '@simlab/kernel';
import type { Executable, ProcessInput } from '../types.ts';

/** 2026-11-16 05:47:37.250 UTC. */
export const T0 = millisFromCivil(2026, 11, 16, 5, 47, 37, 250);

export interface FakeImage {
  /** Absolute path → executable; names without a slash are looked up in PATH order below. */
  files: Record<string, Omit<Executable, 'path'>>;
  path?: string[];
  etc?: Record<string, string>;
}

export function processInput(img: FakeImage, exePath: string, argv: string[], env: [string, string][], over: Partial<ProcessInput> = {}): ProcessInput {
  const dirs = img.path ?? ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];
  const which = (name: string): Executable | undefined => {
    if (name.includes('/')) {
      const f = img.files[name];
      return f ? { path: name, ...f } : undefined;
    }
    for (const d of dirs) {
      const f = img.files[`${d}/${name}`];
      if (f) return { path: `${d}/${name}`, ...f };
    }
    return undefined;
  };
  const exe = which(exePath);
  if (!exe) throw new Error(`no ${exePath} in the fake image`);
  return { argv, env, exe, pid: 1, init: true, hostname: 'web-0', cpus: 2, now: T0, which, file: (p) => img.etc?.[p], ...over };
}

/** The log lines a step writes, with their stream and delay. */
export function lines(step: { output?: { after?: number; stream: string; text: string }[] }): string[] {
  return (step.output ?? []).flatMap((o) =>
    o.text
      .replace(/\n$/, '')
      .split('\n')
      .map((t) => `${o.stream === 'stderr' ? 'E' : 'O'} +${o.after ?? 0} ${t}`),
  );
}
