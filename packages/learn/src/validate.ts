// Content validation (docs/SCENARIO_FORMAT.md §12): what `npm run content:check` enforces for
// every item. Static rules need only the item and the registry; the run rules build the world
// for several seeds and grade it untouched (it must fail) and after each reference solution (it
// must pass): CLAUDE.md hard rule 6.

import { CHECK, FAULT, STEP, TOPOLOGY, type CheckSpec, type FaultSpec, type Json, type Registry, type StepSpec, type TopologySpec } from '@simlab/kernel';
import { formatSchemaErrors, validateSchema } from './item/jsonschema.ts';
import { itemSchema } from './item/schema.ts';
import type { Item, JsonObject, Step, Variant } from './item/types.ts';
import { matches, PlaceholderError, resolveParams, variantOf } from './item/variant.ts';
import { BUILTIN_STEP_NAMES } from './runner/builtin.ts';
import { buildBaseline, ItemError, startSession, type Baseline, type BuildOptions } from './runner/build.ts';
import { grade, type GradeReport } from './runner/grader.ts';
import { runSteps, StepFailure, stepKind } from './runner/steps.ts';
import { figuresOf } from './figure/blocks.ts';
import { figureWorlds, renderFigure, renderProblems } from './figure/render.ts';
import type { Block, Figure } from './figure/types.ts';

export interface StaticContext {
  registry: Registry;
  /** Competency ids from docs/curriculum/competencies.yaml. */
  competencies: ReadonlySet<string>;
  /** Skill ids the packs define. */
  skills: ReadonlySet<string>;
  /** The file's base name without `.yaml`, which must equal the id. */
  fileId?: string;
  /** Ids of the divergence register (docs/FIDELITY.md §5); when given, a figure's note must cite one of them. */
  divergences?: ReadonlySet<string>;
}

const schemaCache = new WeakMap<Registry, JsonObject>();

export function schemaFor(registry: Registry): JsonObject {
  let s = schemaCache.get(registry);
  if (!s) {
    s = itemSchema(registry) as JsonObject;
    schemaCache.set(registry, s);
  }
  return s;
}

/** Rule 1 alone: the raw item against the generated schema. Returns the item when it is valid. */
export function parseItem(raw: Json, registry: Registry): { item?: Item; problems: string[] } {
  const problems = formatSchemaErrors(validateSchema(schemaFor(registry), raw));
  return problems.length === 0 ? { item: raw as unknown as Item, problems } : { problems };
}

const PLACEHOLDER = /(?<!\\)\{\{\s*([^}]*?)\s*\}\}/g;

function strings(value: unknown, path: string, out: { path: string; text: string }[]): void {
  if (typeof value === 'string') out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) if (k !== 'when') strings(v, path ? `${path}.${k}` : k, out);
}

function whens(value: unknown, path: string, out: { path: string; when: JsonObject }[]): void {
  if (Array.isArray(value)) value.forEach((v, i) => whens(v, `${path}[${i}]`, out));
  else if (value !== null && typeof value === 'object') {
    const o = value as JsonObject;
    if (o['when'] !== null && typeof o['when'] === 'object' && !Array.isArray(o['when'])) out.push({ path, when: o['when'] });
    for (const [k, v] of Object.entries(o)) if (k !== 'when') whens(v, path ? `${path}.${k}` : k, out);
  }
}

/** The figures of a prose field, with their paths. */
function rawFigures(value: string | readonly Block[], field: string): { path: string; figure: Figure }[] {
  if (typeof value === 'string') return [];
  return value.flatMap((b, i) => ('figure' in b ? [{ path: `${field}[${i}].figure`, figure: b.figure }] : []));
}

/** The steps a figure runs: a scene's own world and its frames. */
function figureSteps(path: string, f: Figure): { path: string; step: Step }[] {
  if (f.kind !== 'scene') return [];
  const out: { path: string; step: Step }[] = [];
  (f.world?.setup ?? []).forEach((st, j) => out.push({ path: `${path}.world.setup[${j}]`, step: st }));
  f.frames.forEach((fr, k) => (fr.steps ?? []).forEach((st, j) => out.push({ path: `${path}.frames[${k}].steps[${j}]`, step: st })));
  return out;
}

/**
 * What a ticket's figure may be (§11): a view of the start or of the learner's world, or a
 * diagram, never the solved world, a comparison or a scene; and a view names the facts it shows,
 * so a reviewer sees at a glance that none of them gives the cause away.
 */
function ticketFigureProblems(path: string, f: Figure): string[] {
  if (f.kind === 'compare' || f.kind === 'scene') return [`${path}: a ticket's figure is a view or a diagram, not a ${f.kind}`];
  if (f.kind === 'view' && f.of === 'solved') return [`${path}: a ticket's figure never shows the solved world`];
  if (f.kind === 'view' && f.show === undefined) return [`${path}: a ticket's view names the facts it shows (\`show\`, [] for none)`];
  return [];
}

/** Every step of an item, with its path: setup, solutions, checks' `after` and `until`, scenes. */
function allSteps(item: Item): { path: string; step: Step }[] {
  const out: { path: string; step: Step }[] = [];
  for (const { path, figure } of [...rawFigures(item.ticket, 'ticket'), ...rawFigures(item.debrief, 'debrief')]) out.push(...figureSteps(path, figure));
  (item.world.setup ?? []).forEach((s, i) => out.push({ path: `world.setup[${i}]`, step: s }));
  item.solutions.forEach((s, i) => (Array.isArray(s) ? s : s.steps).forEach((st, j) => out.push({ path: `solutions[${i}]${Array.isArray(s) ? '' : '.steps'}[${j}]`, step: st })));
  item.checks.forEach((c, i) => (c.after ?? []).forEach((st, j) => out.push({ path: `checks[${i}].after[${j}]`, step: st })));
  return out;
}

/** Rules 1, 2, 3 and 8: everything that needs no world. */
export function staticProblems(raw: Json, ctx: StaticContext): string[] {
  const { item, problems } = parseItem(raw, ctx.registry);
  if (!item) return problems;
  const out: string[] = [];
  if (ctx.fileId !== undefined && item.id !== ctx.fileId) out.push(`id ${item.id} differs from the file name ${ctx.fileId}.yaml`);
  for (const s of item.skills) if (!ctx.skills.has(s)) out.push(`skills: ${s} is not defined in a pack.yaml`);
  for (const c of item.curriculum) if (!ctx.competencies.has(c)) out.push(`curriculum: ${c} is not in docs/curriculum/competencies.yaml`);
  const params = item.world.params ?? {};
  const found: { path: string; text: string }[] = [];
  const { params: _p, topology: _t, topologyParams: _tp, entry: _e, startTime: _s, ...worldRest } = item.world;
  strings({ world: worldRest, ticket: item.ticket, hints: item.hints, checks: item.checks, solutions: item.solutions, debrief: item.debrief }, '', found);
  const used = new Set<string>();
  for (const s of found) {
    for (const m of s.text.matchAll(PLACEHOLDER)) {
      const name = m[1] as string;
      used.add(name);
      if (!Object.hasOwn(params, name)) out.push(`${s.path}: {{${name}}} names no parameter`);
    }
  }
  const ws: { path: string; when: JsonObject }[] = [];
  whens(item, '', ws);
  for (const w of ws) {
    for (const [k, v] of Object.entries(w.when)) {
      used.add(k);
      const gen = params[k];
      if (!gen || !('pick' in gen)) {
        out.push(`${w.path}.when: ${k} is not a pick parameter`);
        continue;
      }
      for (const x of Array.isArray(v) ? v : [v]) if (!gen.pick.some((p) => p === x)) out.push(`${w.path}.when: ${JSON.stringify(x)} is not an option of ${k}`);
    }
  }
  for (const name of Object.keys(params)) if (!used.has(name)) out.push(`world.params.${name} is never used`);
  const ids = item.checks.map((c) => c.id);
  for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) out.push(`checks: id ${id} is used twice`);
  for (const { path, figure } of rawFigures(item.ticket, 'ticket')) out.push(...ticketFigureProblems(path, figure));
  if (ctx.divergences) {
    for (const { path, figure } of [...rawFigures(item.ticket, 'ticket'), ...rawFigures(item.debrief, 'debrief')]) {
      const notes = [...(figure.notes ?? []), ...(figure.kind === 'scene' ? figure.frames.flatMap((f) => f.notes ?? []) : [])];
      for (const n of notes) if (n.divergence !== undefined && !ctx.divergences.has(n.divergence)) out.push(`${path}: ${n.divergence} is not in the divergence register (docs/FIDELITY.md)`);
    }
  }
  for (const { path, step } of allSteps(item)) {
    try {
      const kind = stepKind(step, ctx.registry);
      if (kind === 'fault' && path.startsWith('solutions')) out.push(`${path}: solutions never inject faults`);
    } catch (e) {
      out.push(`${path}: ${(e as Error).message}`);
    }
  }
  const topology = ctx.registry.get<TopologySpec>(TOPOLOGY, item.world.topology);
  if (topology) out.push(...formatSchemaErrors(validateSchema(topology.params as JsonObject, (item.world.topologyParams ?? {}) as Json)).map((e) => `world.topologyParams: ${e}`));
  return out;
}

/** The argument maps of a variant, typed, against the schemas the plugins registered; and rule 7. */
export function variantProblems(v: Variant, registry: Registry): string[] {
  const out: string[] = [];
  const minHints = v.item.kind === 'drill' ? 1 : 3;
  if (v.hints.length < minHints) out.push(`${v.hints.length} hint${v.hints.length === 1 ? '' : 's'} for this variant; a ${v.item.kind} needs at least ${minHints}`);
  if (v.solutions.length === 0) out.push('no reference solution applies to this variant');
  if (v.checks.length === 0) out.push('no check applies to this variant');
  const checkArgs = (where: string, name: string, args: Json): void => {
    const spec = registry.get<CheckSpec>(CHECK, name);
    if (spec) out.push(...formatSchemaErrors(validateSchema(spec.args as JsonObject, args)).map((e) => `${where}.with: ${e}`));
  };
  const stepArgs = (where: string, step: Step): void => {
    const kind = stepKind(step, registry);
    if (kind === 'until') {
      const u = step['until'] as JsonObject;
      checkArgs(`${where}.until`, String(u['assert']), u['with'] ?? {});
    } else if (kind === 'fault') {
      const spec = registry.get<FaultSpec>(FAULT, String(step['fault']));
      if (spec) out.push(...formatSchemaErrors(validateSchema(spec.args as JsonObject, step['with'] ?? {})).map((e) => `${where}.with: ${e}`));
    } else if (!BUILTIN_STEP_NAMES.includes(kind)) {
      const spec = registry.get<StepSpec>(STEP, kind);
      if (spec) out.push(...formatSchemaErrors(validateSchema(spec.args as JsonObject, step as Json)).map((e) => `${where}: ${e}`));
    }
  };
  v.setup.forEach((s, i) => stepArgs(`setup[${i}]`, s));
  [...figuresOf(v.ticket).map((f, i) => ({ f, where: `ticket figure ${i + 1}` })), ...figuresOf(v.debrief).map((f, i) => ({ f, where: `debrief figure ${i + 1}` }))].forEach(({ f, where }) => {
    if (f.kind !== 'scene') return;
    (f.world?.setup ?? []).forEach((st, j) => stepArgs(`${where}.world.setup[${j}]`, st));
    f.frames.forEach((fr, k) => (fr.steps ?? []).forEach((st, j) => stepArgs(`${where}.frames[${k}][${j}]`, st)));
  });
  // PLAN.md §5: the debrief opens with figures of the cause and the fix; prose alone is a defect.
  if (!v.debrief[0] || !('figure' in v.debrief[0])) out.push('the debrief of this variant does not open with a figure');
  v.solutions.forEach((s, i) => s.steps.forEach((st, j) => stepArgs(`solution ${i + 1}[${j}]`, st)));
  for (const c of v.checks) {
    checkArgs(`check ${c.id}`, c.assert, c.with);
    c.after.forEach((st, j) => stepArgs(`check ${c.id}.after[${j}]`, st));
  }
  return out;
}

/**
 * Seeds to validate with: 1 to `count`, then more until every `pick` value used in a `when` has
 * appeared at least once (§4), up to 50 extra seeds. A value never reached is a problem.
 */
export function seedsFor(item: Item, count: number): { seeds: number[]; uncovered: string[] } {
  const ws: { path: string; when: JsonObject }[] = [];
  whens(item, '', ws);
  const wanted = new Map<string, Set<string>>();
  for (const w of ws) for (const k of Object.keys(w.when)) wanted.set(k, new Set(((item.world.params?.[k] as { pick?: Json[] } | undefined)?.pick ?? []).map((x) => JSON.stringify(x))));
  const seeds: number[] = [];
  const seen = new Map<string, Set<string>>([...wanted.keys()].map((k) => [k, new Set<string>()]));
  const covered = (): boolean => [...wanted].every(([k, vals]) => [...vals].every((x) => seen.get(k)?.has(x)));
  for (let seed = 1; seed <= count + 50; seed++) {
    if (seed > count && covered()) break;
    const params = resolveParams(item, seed);
    const adds = [...wanted.keys()].some((k) => !seen.get(k)?.has(JSON.stringify(params[k])));
    if (seed > count && !adds) continue;
    seeds.push(seed);
    for (const k of wanted.keys()) seen.get(k)?.add(JSON.stringify(params[k]));
  }
  const uncovered = [...wanted].flatMap(([k, vals]) => [...vals].filter((x) => !seen.get(k)?.has(x)).map((x) => `${k}=${x}`));
  return { seeds, uncovered };
}

export interface SeedResult {
  seed: number;
  params: Json;
  problems: string[];
  /** The untouched world's grade. */
  untouched?: GradeReport;
  /** One grade per solution that ran to the end. */
  solved: { name: string; report: GradeReport }[];
}

const solutionName = (v: Variant, i: number): string => v.solutions[i]?.name ?? `solution ${i + 1}`;

/** Rules 4 to 7 for one seed. */
export function runSeed(item: Item, seed: number, registry: Registry, options: BuildOptions = {}): SeedResult {
  const result: SeedResult = { seed, params: {}, problems: [], solved: [] };
  let v: Variant;
  try {
    v = variantOf(item, seed);
  } catch (e) {
    if (e instanceof PlaceholderError) {
      result.problems.push(e.message);
      return result;
    }
    throw e;
  }
  result.params = v.params;
  result.problems.push(...variantProblems(v, registry));
  if (result.problems.length > 0) return result;
  let baseline: Baseline;
  try {
    baseline = buildBaseline(v, registry, options);
  } catch (e) {
    if (e instanceof StepFailure || e instanceof ItemError) {
      result.problems.push(`setup failed: ${e.message}`);
      return result;
    }
    throw e;
  }
  const env = { registry, entry: baseline.entry, baseline: baseline.kernel.world };
  const untouched = grade(startSession(baseline).kernel, v.checks, env);
  result.untouched = untouched;
  for (const c of untouched.checks) if (c.status === 'error') result.problems.push(`untouched world: check ${c.id} could not be evaluated: ${c.error ?? ''}`);
  if (untouched.passed) result.problems.push('untouched world: every check passes; the item must fail before it is solved');
  else if (!untouched.checks.some((c) => c.status === 'fail')) result.problems.push('untouched world: no check fails');
  v.solutions.forEach((s, i) => {
    const { kernel: k, hub } = startSession(baseline);
    try {
      runSteps(k, s.steps, { registry, entry: baseline.entry, hub, baseline: baseline.kernel.world }, solutionName(v, i));
    } catch (e) {
      if (e instanceof StepFailure) {
        result.problems.push(`${solutionName(v, i)}: ${e.message}`);
        return;
      }
      throw e;
    }
    const report = grade(k, v.checks, env);
    result.solved.push({ name: solutionName(v, i), report });
    for (const c of report.checks) {
      if (c.status !== 'pass') result.problems.push(`${solutionName(v, i)}: check ${c.id} ${c.status === 'error' ? `could not be evaluated: ${c.error ?? ''}` : `fails: wanted ${c.expected}; ${c.observed}`}`);
    }
  });
  result.problems.push(...figureProblems(v, baseline, registry, options));
  return result;
}

/**
 * Every figure of a variant resolves (§11): its worlds build, its focus selects something, what it
 * highlights and notes exists, a scene runs without a gap and every frame changes something. `now`
 * is shown as the untouched start.
 */
export function figureProblems(v: Variant, baseline: Baseline, registry: Registry, options: BuildOptions = {}): string[] {
  const env = { registry, baseline, build: options };
  const worlds = figureWorlds(env);
  const out: string[] = [];
  const all = [...figuresOf(v.ticket).map((f, i) => ({ f, where: `ticket figure ${i + 1}` })), ...figuresOf(v.debrief).map((f, i) => ({ f, where: `debrief figure ${i + 1}` }))];
  for (const { f, where } of all) out.push(...renderProblems(renderFigure(f, worlds, env), true).map((p) => `${where} (${f.kind}): ${p}`));
  return out;
}

export { matches };
