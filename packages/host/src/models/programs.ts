// The generic program models: the container shell, the small utilities, and the stand-in for an
// executable that exists in an image but has no model (a gap, not a guess).

import type { Json } from '@simlab/kernel';
import { resumeShell, signalShell, startShell } from './sh/run.ts';
import type { ModelStep, ProcessInput, ProgramModel } from './types.ts';
import { runUtility, UTILITIES } from './utilities.ts';

export const shModel: ProgramModel = {
  name: 'sh',
  start: startShell,
  resume: resumeShell,
  signal: signalShell,
};

function utilityModel(name: string): ProgramModel {
  return {
    name,
    start(p: ProcessInput): ModelStep {
      const r = runUtility(name, p.exe.variant, p.argv.slice(1), p.env, p, name);
      const base = { ...(r?.output.length ? { output: r.output } : {}), ...(r?.gaps?.length ? { gaps: r.gaps } : {}) };
      if (!r) return { next: { exit: 0 } };
      if (r.sleep === Infinity) return { ...base, next: { wait: true, state: { status: r.status } } };
      if (r.sleep !== undefined && r.sleep > 0) return { ...base, next: { wake: Math.round(r.sleep), state: { status: r.status } } };
      return { ...base, next: { exit: r.status } };
    },
    resume(_p, state: Json): ModelStep {
      return { next: { exit: (state as { status: number }).status } };
    },
  };
}

/**
 * An executable the image has but no model implements. It keeps running without output, and the
 * gap log says so: the simulator cannot know what it would have done.
 */
export const unmodeledModel: ProgramModel = {
  name: 'unmodeled',
  start(p) {
    return { gaps: [{ what: `running ${p.exe.path} in a container`, detail: `no behavior model for ${p.argv.join(' ')}` }], next: { wait: true, state: null } };
  },
  resume: () => ({ next: { wait: true, state: null } }),
};

/** The models the host plugin contributes. */
export const GENERIC_MODELS: readonly ProgramModel[] = [shModel, unmodeledModel, ...UTILITIES.map(utilityModel)];
