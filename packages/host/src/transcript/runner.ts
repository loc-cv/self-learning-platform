// Runs a transcript against a fresh simulated world and reports each step's actual result.

import { bootKernel, createRegistry, DEFAULT_START_TIME, type GapEvent, type Kernel, type Plugin, type Ports } from '@simlab/kernel';
import { buildUbuntuBase } from '../base/ubuntu.ts';
import { createMachine } from '../machine.ts';
import { hostPlugin } from '../plugin.ts';
import type { Transcript, TranscriptStep } from './format.ts';
import { captureOutput, openSession } from './session.ts';

export interface StepResult {
  step: TranscriptStep;
  output: string;
  status: number;
  finished: boolean;
}

export interface TranscriptWorld {
  kernel: Kernel;
  machine: string;
  user: string;
}

/** The default world of a host transcript: one Ubuntu machine `node01` with the user `student`. */
export function defaultTranscriptWorld(ports: Ports, plugins: Plugin[] = []): TranscriptWorld {
  const kernel = bootKernel(createRegistry([hostPlugin, ...plugins]), { seed: 1, startTime: DEFAULT_START_TIME, ports });
  kernel.act('setup', (ctx) => {
    createMachine(ctx, { id: 'node01', hostname: 'node01', kind: 'node' });
    buildUbuntuBase(ctx, 'node01', { user: { name: 'student' } });
  });
  return { kernel, machine: 'node01', user: 'student' };
}

export interface TranscriptRun {
  results: StepResult[];
  /** Gap records emitted while the transcript ran. */
  gaps: GapEvent[];
}

export function runTranscript(t: Transcript, world: (ports: Ports) => TranscriptWorld = (ports) => defaultTranscriptWorld(ports)): TranscriptRun {
  const capture = captureOutput();
  const gaps: GapEvent[] = [];
  const w = world({ ...capture.ports, gap: (g) => gaps.push(g) });
  const session = openSession(w.kernel, capture, { machine: w.machine, user: w.user, cols: t.cols });
  const results: StepResult[] = [];
  for (const step of t.steps) {
    const r = session.run(step.command);
    results.push({ step, output: r.output, status: r.status, finished: r.finished });
    if (r.exited) break;
  }
  return { results, gaps };
}
