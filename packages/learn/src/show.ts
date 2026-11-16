// Reference solutions as the learner reads them (docs/SCENARIO_FORMAT.md §10): each step in the
// words its plugin gives it (`StepSpec.show`), the runner's own steps in plain language.

import { STEP, type Registry, type StepSpec } from '@simlab/kernel';
import type { JsonObject, Solution, Step } from './item/types.ts';
import { stepKind } from './runner/steps.ts';

function showAssertion(u: JsonObject): string {
  const w = u['with'] as JsonObject | undefined;
  const args = w ? Object.entries(w).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ') : '';
  return `${u['not'] === true ? 'not ' : ''}${String(u['assert'])}${args ? ` (${args})` : ''}`;
}

export function showStep(step: Step, registry: Registry): string {
  const kind = stepKind(step, registry);
  const { when: _w, ...args } = step;
  if (kind === 'advance') return `# let ${String(args['advance'])} pass`;
  if (kind === 'until') return `# wait until ${showAssertion(args['until'] as JsonObject)}, at most ${String(args['timeout'])}`;
  if (kind === 'fault') return `# fault ${String(args['fault'])}`;
  const spec = registry.get<StepSpec>(STEP, kind);
  return spec?.show ? spec.show(args) : `# ${kind}: ${JSON.stringify(args[kind])}`;
}

export function showSolution(s: Solution, registry: Registry): string {
  return s.steps.map((st) => showStep(st, registry)).join('\n');
}
