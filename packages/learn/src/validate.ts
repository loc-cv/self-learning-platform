// Content validation (docs/SCENARIO_FORMAT.md §12): what `npm run content:check` enforces for
// every item. Static rules need only the item and the registry; the run rules build the world
// for several seeds and grade it untouched (it must fail) and after each reference solution (it
// must pass): CLAUDE.md hard rule 6.

import { CHECK, FAULT, STEP, TOPOLOGY, type CheckSpec, type FaultSpec, type Json, type Registry, type StepSpec, type TopologySpec } from '@simlab/kernel';
import { formatSchemaErrors, validateSchema } from './item/jsonschema.ts';
import { itemSchema } from './item/schema.ts';
import { isScenario, type AnyItem, type CardItem, type Check, type ExamItem, type Item, type ItemKind, type JsonObject, type LessonItem, type Step, type Variant } from './item/types.ts';
import { cardVariantOf, lessonVariantOf, matches, PlaceholderError, RESERVED_PLACEHOLDER, resolveParams, scenarioShape, variantOf } from './item/variant.ts';
import { BUILTIN_STEP_NAMES } from './runner/builtin.ts';
import { buildBaseline, ItemError, startSession, type Baseline, type BuildOptions } from './runner/build.ts';
import { grade, type GradeReport } from './runner/grader.ts';
import { runSteps, StepFailure, stepKind } from './runner/steps.ts';
import { figuresOf } from './figure/blocks.ts';
import { FigureError, figureWorlds, renderFigure, renderProblems, type FigureWorlds } from './figure/render.ts';
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
  /** Every item id with its kind; when given, an exam's tasks must name lab-like items. */
  items?: ReadonlyMap<string, ItemKind>;
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
export function parseAnyItem(raw: Json, registry: Registry): { item?: AnyItem; problems: string[] } {
  const problems = formatSchemaErrors(validateSchema(schemaFor(registry), raw));
  return problems.length === 0 ? { item: raw as unknown as AnyItem, problems } : { problems };
}

/** `parseAnyItem` for a lab, drill or incident; another kind is a problem. */
export function parseItem(raw: Json, registry: Registry): { item?: Item; problems: string[] } {
  const { item, problems } = parseAnyItem(raw, registry);
  if (!item) return { problems };
  return isScenario(item) ? { item, problems } : { problems: [`a ${item.kind} is not a lab, drill or incident`] };
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

type Practiced = Exclude<AnyItem, ExamItem>;

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

/** What the static rules look at, whatever the kind of item. */
interface Parts {
  /** Everything whose strings may hold placeholders. */
  prose: unknown;
  /** Figures as written; `ticket` marks the ones a ticket shows. */
  figures: { path: string; figure: Figure; ticket: boolean }[];
  /** Every step; `solution` marks reference solutions, which never inject faults. */
  steps: { path: string; step: Step; solution: boolean }[];
  checks: { id: string }[];
}

function blockFigures(value: string | readonly Block[], field: string, ticket: boolean): Parts['figures'] {
  if (typeof value === 'string') return [];
  return value.flatMap((b, i) => ('figure' in b ? [{ path: `${field}[${i}].figure`, figure: b.figure, ticket }] : []));
}

function partsOf(item: Practiced): Parts {
  const { params: _p, topology: _t, topologyParams: _tp, entry: _e, startTime: _s, ...worldRest } = item.world ?? ({} as Partial<Item['world']>);
  const steps: Parts['steps'] = [];
  (item.world?.setup ?? []).forEach((s, i) => steps.push({ path: `world.setup[${i}]`, step: s, solution: false }));
  let figures: Parts['figures'];
  let prose: unknown;
  let checks: { id: string }[];
  const checkSteps = (list: readonly { after?: Step[] }[], where: string): void => list.forEach((c, i) => (c.after ?? []).forEach((st, j) => steps.push({ path: `${where}[${i}].after[${j}]`, step: st, solution: false })));
  if (item.kind === 'lesson') {
    prose = { world: worldRest, steps: item.steps };
    figures = item.steps.flatMap((s, i) => ('figure' in s ? [{ path: `steps[${i}].figure`, figure: s.figure, ticket: false }] : []));
    checks = [];
    item.steps.forEach((s, i) => {
      if (!('task' in s)) return;
      checks.push(...s.task.checks);
      s.task.solution.forEach((st, j) => steps.push({ path: `steps[${i}].task.solution[${j}]`, step: st, solution: true }));
      checkSteps(s.task.checks, `steps[${i}].task.checks`);
    });
  } else if (item.kind === 'card') {
    prose = { world: worldRest, prompt: item.prompt, figure: item.figure, answer: item.answer, choices: item.choices, checks: item.checks, solution: item.solution };
    figures = item.figure ? [{ path: 'figure', figure: item.figure, ticket: false }] : [];
    checks = item.checks ?? [];
    (item.solution ?? []).forEach((st, j) => steps.push({ path: `solution[${j}]`, step: st, solution: true }));
    checkSteps(item.checks ?? [], 'checks');
  } else {
    prose = { world: worldRest, ticket: item.ticket, hints: item.hints, checks: item.checks, solutions: item.solutions, debrief: item.debrief };
    figures = [...blockFigures(item.ticket, 'ticket', true), ...blockFigures(item.debrief, 'debrief', false)];
    checks = item.checks;
    item.solutions.forEach((s, i) => (Array.isArray(s) ? s : s.steps).forEach((st, j) => steps.push({ path: `solutions[${i}]${Array.isArray(s) ? '' : '.steps'}[${j}]`, step: st, solution: true })));
    checkSteps(item.checks, 'checks');
  }
  for (const { path, figure } of figures) steps.unshift(...figureSteps(path, figure).map((s) => ({ ...s, solution: false })));
  return { prose, figures, steps, checks };
}

/** An exam's rules (docs/LEARNING_MODEL.md §2.3): its tasks are lab-like items, each once. */
function examProblems(item: ExamItem, ctx: StaticContext): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  item.tasks.forEach((t, i) => {
    if (seen.has(t.item)) out.push(`tasks[${i}]: ${t.item} is a task twice`);
    seen.add(t.item);
    if (!ctx.items) return;
    const kind = ctx.items.get(t.item);
    if (kind === undefined) out.push(`tasks[${i}]: no item ${t.item}`);
    else if (kind !== 'lab' && kind !== 'drill' && kind !== 'incident') out.push(`tasks[${i}]: ${t.item} is a ${kind}; an exam task is a lab, a drill or an incident`);
  });
  return out;
}

/** What only a lesson or a card can get wrong before any world is built. */
function kindProblems(item: LessonItem | CardItem): string[] {
  const out: string[] = [];
  const choiceProblems = (where: string, choices: string[] | undefined, answer: number | undefined, key: string): void => {
    if (choices === undefined && answer !== undefined) out.push(`${where}: \`${key}\` needs \`choices\``);
    if (choices !== undefined && answer === undefined) out.push(`${where}: \`choices\` need \`${key}\`, the index of the correct one`);
    if (choices !== undefined && answer !== undefined && answer >= choices.length) out.push(`${where}: \`${key}\` is ${answer}, and there are ${choices.length} choices`);
  };
  if (item.kind === 'lesson') {
    item.steps.forEach((s, i) => {
      if ('predict' in s) choiceProblems(`steps[${i}].predict`, s.predict.choices, s.predict.answer, 'answer');
    });
    return out;
  }
  choiceProblems('card', item.choices, item.correct, 'correct');
  if (item.choices !== undefined && item.checks !== undefined) out.push('a card is checked by choice or by command, not both (`choices` and `checks`)');
  if ((item.checks === undefined) !== (item.solution === undefined)) out.push('`checks` and `solution` go together: the solution proves the checks can pass');
  if (item.checks !== undefined && item.world === undefined) out.push('`checks` need a `world` to run in');
  if (item.figure !== undefined && item.figure.kind !== 'diagram' && item.world === undefined) out.push(`figure: a ${item.figure.kind} shows a world; without \`world\` only a diagram is possible`);
  if (item.figure !== undefined && item.solution === undefined && figureNames(item.figure).includes('solved')) out.push('figure: the solved world needs `solution`');
  return out;
}

/** The worlds a figure names. */
function figureNames(f: Figure): string[] {
  return f.kind === 'view' ? [f.of] : f.kind === 'compare' ? [f.left.of, f.right.of] : [];
}

/** Rules 1, 2, 3 and 8: everything that needs no world. */
export function staticProblems(raw: Json, ctx: StaticContext): string[] {
  const { item, problems } = parseAnyItem(raw, ctx.registry);
  if (!item) return problems;
  const out: string[] = [];
  if (ctx.fileId !== undefined && item.id !== ctx.fileId) out.push(`id ${item.id} differs from the file name ${ctx.fileId}.yaml`);
  if (item.kind === 'exam') return [...out, ...examProblems(item, ctx)];
  for (const s of item.skills) if (!ctx.skills.has(s)) out.push(`skills: ${s} is not defined in a pack.yaml`);
  for (const c of item.curriculum) if (!ctx.competencies.has(c)) out.push(`curriculum: ${c} is not in docs/curriculum/competencies.yaml`);
  if (item.kind === 'lesson' || item.kind === 'card') out.push(...kindProblems(item));
  const parts = partsOf(item);
  const params = item.world?.params ?? {};
  const found: { path: string; text: string }[] = [];
  strings(parts.prose, '', found);
  const used = new Set<string>();
  for (const s of found) {
    for (const m of s.text.matchAll(PLACEHOLDER)) {
      const name = m[1] as string;
      used.add(name);
      if (Object.hasOwn(params, name)) continue;
      // A scene frame's caption may quote the trace event the frame is anchored to (§11.6).
      if (name === RESERVED_PLACEHOLDER && /\.frames\[\d+\]\.caption$/.test(s.path)) continue;
      out.push(`${s.path}: {{${name}}} names no parameter`);
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
  const ids = parts.checks.map((c) => c.id);
  for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) out.push(`checks: id ${id} is used twice`);
  for (const { path, figure, ticket } of parts.figures) if (ticket) out.push(...ticketFigureProblems(path, figure));
  if (ctx.divergences) {
    for (const { path, figure } of parts.figures) {
      const notes = [...(figure.notes ?? []), ...(figure.kind === 'scene' ? figure.frames.flatMap((f) => f.notes ?? []) : [])];
      for (const n of notes) if (n.divergence !== undefined && !ctx.divergences.has(n.divergence)) out.push(`${path}: ${n.divergence} is not in the divergence register (docs/FIDELITY.md)`);
    }
  }
  for (const { path, step, solution } of parts.steps) {
    try {
      const kind = stepKind(step, ctx.registry);
      if (kind === 'fault' && solution) out.push(`${path}: solutions never inject faults`);
    } catch (e) {
      out.push(`${path}: ${(e as Error).message}`);
    }
  }
  const topology = item.world ? ctx.registry.get<TopologySpec>(TOPOLOGY, item.world.topology) : undefined;
  if (topology) out.push(...formatSchemaErrors(validateSchema(topology.params as JsonObject, (item.world?.topologyParams ?? {}) as Json)).map((e) => `world.topologyParams: ${e}`));
  return out;
}

/** Argument maps against the schemas the plugins registered, after substitution. */
function argChecker(registry: Registry, out: string[]): { check(where: string, c: Check): void; step(where: string, step: Step): void; figures(figs: readonly { f: Figure; where: string }[]): void } {
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
  return {
    check(where, c) {
      checkArgs(where, c.assert, c.with);
      c.after.forEach((st, j) => stepArgs(`${where}.after[${j}]`, st));
    },
    step: stepArgs,
    figures(figs) {
      for (const { f, where } of figs) {
        if (f.kind !== 'scene') continue;
        (f.world?.setup ?? []).forEach((st, j) => stepArgs(`${where}.world.setup[${j}]`, st));
        f.frames.forEach((fr, k) => (fr.steps ?? []).forEach((st, j) => stepArgs(`${where}.frames[${k}][${j}]`, st)));
      }
    },
  };
}

/** The argument maps of a variant, typed, against the schemas the plugins registered; and rule 7. */
export function variantProblems(v: Variant, registry: Registry): string[] {
  const out: string[] = [];
  const minHints = v.item.kind === 'drill' ? 1 : 3;
  if (v.hints.length < minHints) out.push(`${v.hints.length} hint${v.hints.length === 1 ? '' : 's'} for this variant; a ${v.item.kind} needs at least ${minHints}`);
  if (v.solutions.length === 0) out.push('no reference solution applies to this variant');
  if (v.checks.length === 0) out.push('no check applies to this variant');
  const args = argChecker(registry, out);
  v.setup.forEach((s, i) => args.step(`setup[${i}]`, s));
  args.figures([...figuresOf(v.ticket).map((f, i) => ({ f, where: `ticket figure ${i + 1}` })), ...figuresOf(v.debrief).map((f, i) => ({ f, where: `debrief figure ${i + 1}` }))]);
  // PLAN.md §5: the debrief opens with figures of the cause and the fix; prose alone is a defect.
  if (!v.debrief[0] || !('figure' in v.debrief[0])) out.push('the debrief of this variant does not open with a figure');
  v.solutions.forEach((s, i) => s.steps.forEach((st, j) => args.step(`solution ${i + 1}[${j}]`, st)));
  for (const c of v.checks) args.check(`check ${c.id}`, c);
  return out;
}

/**
 * Seeds to validate with: 1 to `count`, then more until every `pick` value used in a `when` has
 * appeared at least once (§4), up to 50 extra seeds. A value never reached is a problem.
 */
export function seedsFor(item: Practiced, count: number): { seeds: number[]; uncovered: string[] } {
  const ws: { path: string; when: JsonObject }[] = [];
  whens(item, '', ws);
  const wanted = new Map<string, Set<string>>();
  for (const w of ws) for (const k of Object.keys(w.when)) wanted.set(k, new Set(((item.world?.params?.[k] as { pick?: Json[] } | undefined)?.pick ?? []).map((x) => JSON.stringify(x))));
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
  /** The untouched world's grade (lab-like items and cards checked by command). */
  untouched?: GradeReport;
  /** One grade per solution that ran to the end; for a lesson, one per task. */
  solved: { name: string; report: GradeReport }[];
}

const solutionName = (v: Variant, i: number): string => v.solutions[i]?.name ?? `solution ${i + 1}`;

/** Runs `build`, turning what an author can get wrong into a problem of the seed. */
function attempt<T>(result: SeedResult, what: string, build: () => T): T | undefined {
  try {
    return build();
  } catch (e) {
    if (e instanceof PlaceholderError) result.problems.push(e.message);
    else if (e instanceof StepFailure || e instanceof ItemError) result.problems.push(`${what}: ${e.message}`);
    else throw e;
    return undefined;
  }
}

const failures = (name: string, report: GradeReport): string[] =>
  report.checks.flatMap((c) => (c.status === 'pass' ? [] : [`${name}: check ${c.id} ${c.status === 'error' ? `could not be evaluated: ${c.error ?? ''}` : `fails: wanted ${c.expected}; ${c.observed}`}`]));

/** Rule 5 for a list of checks on a world nothing has solved yet. */
function unsolvedProblems(where: string, report: GradeReport): string[] {
  const out = report.checks.flatMap((c) => (c.status === 'error' ? [`${where}: check ${c.id} could not be evaluated: ${c.error ?? ''}`] : []));
  if (report.passed) out.push(`${where}: every check passes; the item must fail before it is solved`);
  else if (!report.checks.some((c) => c.status === 'fail')) out.push(`${where}: no check fails`);
  return out;
}

/** Rules 4 to 7 and 9 for one seed, for a lab-like item, a lesson or a card. */
export function runSeed(item: Practiced, seed: number, registry: Registry, options: BuildOptions = {}): SeedResult {
  if (item.kind === 'lesson') return runLessonSeed(item, seed, registry, options);
  if (item.kind === 'card') return runCardSeed(item, seed, registry, options);
  const result: SeedResult = { seed, params: {}, problems: [], solved: [] };
  const v = attempt(result, 'variant', () => variantOf(item, seed));
  if (!v) return result;
  result.params = v.params;
  result.problems.push(...variantProblems(v, registry));
  if (result.problems.length > 0) return result;
  const baseline = attempt(result, 'setup failed', () => buildBaseline(v, registry, options));
  if (!baseline) return result;
  const env = { registry, entry: baseline.entry, baseline: baseline.kernel.world };
  const untouched = grade(startSession(baseline).kernel, v.checks, env);
  result.untouched = untouched;
  result.problems.push(...unsolvedProblems('untouched world', untouched));
  v.solutions.forEach((s, i) => {
    const { kernel: k, hub } = startSession(baseline);
    const ran = attempt(result, solutionName(v, i), () => {
      runSteps(k, s.steps, { registry, entry: baseline.entry, hub, baseline: baseline.kernel.world }, solutionName(v, i));
      return true;
    });
    if (!ran) return;
    const report = grade(k, v.checks, env);
    result.solved.push({ name: solutionName(v, i), report });
    result.problems.push(...failures(solutionName(v, i), report));
  });
  result.problems.push(...figureProblems(v, baseline, registry, options));
  return result;
}

/**
 * A lesson for one seed (docs/LEARNING_MODEL.md §2.1): the world builds; in order, every task's
 * checks fail before its solution and pass after it, in the world the tasks before it left; and
 * every figure resolves, `solved` being the world after the last task.
 */
function runLessonSeed(item: LessonItem, seed: number, registry: Registry, options: BuildOptions): SeedResult {
  const result: SeedResult = { seed, params: {}, problems: [], solved: [] };
  const v = attempt(result, 'variant', () => lessonVariantOf(item, seed));
  if (!v) return result;
  result.params = v.params;
  const tasks = v.steps.flatMap((s) => ('task' in s ? [s.task] : []));
  const figures = v.steps.flatMap((s) => ('figure' in s ? [s.figure] : [])).map((f, i) => ({ f, where: `figure ${i + 1}` }));
  if (tasks.length === 0) result.problems.push('no task applies to this variant; a lesson has at least one guided task');
  // PLAN.md §5, show, then tell: a lesson that is only prose is a defect.
  if (figures.length === 0) result.problems.push('no figure applies to this variant; a lesson shows at least one');
  const args = argChecker(registry, result.problems);
  v.setup.forEach((s, i) => args.step(`setup[${i}]`, s));
  args.figures(figures);
  tasks.forEach((t, i) => {
    if (t.checks.length === 0) result.problems.push(`task ${i + 1}: no check applies to this variant`);
    t.checks.forEach((c) => args.check(`task ${i + 1}, check ${c.id}`, c));
    t.solution.forEach((st, j) => args.step(`task ${i + 1}, solution[${j}]`, st));
  });
  if (result.problems.length > 0) return result;
  const shape = scenarioShape(item.world, v, item.id, tasks.flatMap((t) => t.solution));
  const baseline = attempt(result, 'setup failed', () => buildBaseline(shape, registry, options));
  if (!baseline) return result;
  const env = { registry, entry: baseline.entry, baseline: baseline.kernel.world };
  const { kernel, hub } = startSession(baseline);
  for (const [i, t] of tasks.entries()) {
    const name = `task ${i + 1}`;
    result.problems.push(...unsolvedProblems(`${name}, before its solution`, grade(kernel, t.checks, env)));
    const ran = attempt(result, name, () => {
      runSteps(kernel, t.solution, { registry, entry: baseline.entry, hub, baseline: baseline.kernel.world }, name);
      return true;
    });
    if (!ran) break;
    const report = grade(kernel, t.checks, env);
    result.solved.push({ name, report });
    result.problems.push(...failures(name, report));
  }
  result.problems.push(...renderAll(figures, figureWorlds({ registry, baseline, build: options }), { registry, baseline, build: options }));
  return result;
}

/** A card for one seed (docs/LEARNING_MODEL.md §2.2): its world, its checks by command, its figure. */
function runCardSeed(item: CardItem, seed: number, registry: Registry, options: BuildOptions): SeedResult {
  const result: SeedResult = { seed, params: {}, problems: [], solved: [] };
  const v = attempt(result, 'variant', () => cardVariantOf(item, seed));
  if (!v) return result;
  result.params = v.params;
  const figures = v.figure ? [{ f: v.figure, where: 'figure' }] : [];
  const args = argChecker(registry, result.problems);
  (v.world?.setup ?? []).forEach((s, i) => args.step(`setup[${i}]`, s));
  args.figures(figures);
  v.checks.forEach((c) => args.check(`check ${c.id}`, c));
  v.solution.forEach((st, j) => args.step(`solution[${j}]`, st));
  if (item.checks !== undefined && v.checks.length === 0) result.problems.push('no check applies to this variant');
  if (result.problems.length > 0) return result;
  if (!v.world || !item.world) {
    // Only a diagram is possible without a world (kindProblems); it needs none of these.
    const none = (): never => {
      throw new FigureError('the card has no world');
    };
    result.problems.push(...renderAll(figures, { start: none, solved: none, now: none }, { registry, baseline: undefined as never }));
    return result;
  }
  const world = v.world;
  const baseline = attempt(result, 'setup failed', () => buildBaseline(scenarioShape(item.world as Item['world'], world, item.id, v.solution), registry, options));
  if (!baseline) return result;
  if (v.checks.length > 0) {
    const env = { registry, entry: baseline.entry, baseline: baseline.kernel.world };
    const untouched = grade(startSession(baseline).kernel, v.checks, env);
    result.untouched = untouched;
    result.problems.push(...unsolvedProblems('untouched world', untouched));
    const { kernel, hub } = startSession(baseline);
    const ran = attempt(result, 'solution', () => {
      runSteps(kernel, v.solution, { registry, entry: baseline.entry, hub, baseline: baseline.kernel.world }, 'solution');
      return true;
    });
    if (ran) {
      const report = grade(kernel, v.checks, env);
      result.solved.push({ name: 'solution', report });
      result.problems.push(...failures('solution', report));
    }
  }
  result.problems.push(...renderAll(figures, figureWorlds({ registry, baseline, build: options }), { registry, baseline, build: options }));
  return result;
}

function renderAll(figures: readonly { f: Figure; where: string }[], worlds: FigureWorlds, env: { registry: Registry; baseline: Baseline; build?: BuildOptions }): string[] {
  return figures.flatMap(({ f, where }) => renderProblems(renderFigure(f, worlds, env), true).map((p) => `${where} (${f.kind}): ${p}`));
}

/**
 * Every figure of a variant resolves (§11): its worlds build, its focus selects something, what it
 * highlights and notes exists, a scene runs without a gap and every frame changes something. `now`
 * is shown as the untouched start.
 */
export function figureProblems(v: Variant, baseline: Baseline, registry: Registry, options: BuildOptions = {}): string[] {
  const env = { registry, baseline, build: options };
  return renderAll([...figuresOf(v.ticket).map((f, i) => ({ f, where: `ticket figure ${i + 1}` })), ...figuresOf(v.debrief).map((f, i) => ({ f, where: `debrief figure ${i + 1}` }))], figureWorlds(env), env);
}

export { matches };
