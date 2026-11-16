// From an item and a seed to one variant (docs/SCENARIO_FORMAT.md §3, §4): parameters drawn from
// a PRNG stream named after the item, blocks whose `when` does not match dropped, placeholders
// replaced. Pure functions of (item, seed).

import { initialPrngState, randomOver, type Json } from '@simlab/kernel';
import { parseDuration, parseStartTime } from './duration.ts';
import type { Check, CheckDecl, Item, JsonObject, Params, Solution, Step, Variant, When } from './types.ts';

/** The PRNG stream parameters are drawn from: a function of the item id and the seed only. */
export function paramStream(id: string): string {
  return `learn.params:${id}`;
}

/** Draws the parameters in the order written; adding one at the end leaves the others unchanged. */
export function resolveParams(item: Item, seed: number): Params {
  const r = randomOver(initialPrngState(seed, paramStream(item.id)));
  const out: Params = {};
  for (const [name, gen] of Object.entries(item.world.params ?? {})) {
    if ('pick' in gen) out[name] = r.pick(gen.pick);
    else out[name] = gen.int.min + r.int(gen.int.max - gen.int.min + 1);
  }
  return out;
}

/** True when every key of `when` matches the parameter value (a list means any of). */
export function matches(when: When | undefined, params: Params): boolean {
  if (!when) return true;
  return Object.entries(when).every(([k, v]) => (Array.isArray(v) ? v.some((x) => x === params[k]) : v === params[k]));
}

export class PlaceholderError extends Error {}

const PLACEHOLDER = /(\\?)\{\{\s*([^}]*?)\s*\}\}/g;
const WHOLE = /^\{\{\s*([^}]*?)\s*\}\}$/;

/** Replaces `{{name}}` in a string; a string that is exactly one placeholder takes the value's type. */
export function substituteString(text: string, params: Params, where = ''): Json {
  const whole = WHOLE.exec(text);
  if (whole) return lookup(whole[1] as string, params, where);
  return text.replace(PLACEHOLDER, (_m, escape: string, name: string) => {
    if (escape === '\\') return `{{${name}}}`;
    const v = lookup(name, params, where);
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

function lookup(name: string, params: Params, where: string): Json {
  if (!Object.hasOwn(params, name)) throw new PlaceholderError(`${where ? `${where}: ` : ''}{{${name}}} names no parameter`);
  return params[name] as Json;
}

/** Substitutes every string in a value. */
export function substitute(value: Json, params: Params, where = ''): Json {
  if (typeof value === 'string') return substituteString(value, params, where);
  if (Array.isArray(value)) return value.map((v, i) => substitute(v, params, `${where}[${i}]`));
  if (value !== null && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, params, where ? `${where}.${k}` : k);
    return out;
  }
  return value;
}

/** The steps whose `when` matches, without `when`, substituted. Nested `after` lists are not steps' business. */
export function resolveSteps(steps: readonly Step[] | undefined, params: Params, where: string): Step[] {
  const out: Step[] = [];
  (steps ?? []).forEach((s, i) => {
    if (!matches(s.when, params)) return;
    const { when: _w, ...rest } = s;
    out.push(substitute(rest, params, `${where}[${i}]`) as Step);
  });
  return out;
}

function resolveCheck(c: CheckDecl, params: Params, where: string): Check {
  const within = c.within === undefined ? undefined : parseDuration(c.within);
  const out: Check = {
    id: c.id,
    title: substituteString(c.title, params, `${where}.title`) as string,
    assert: c.assert,
    with: substitute(c.with, params, `${where}.with`) as JsonObject,
    not: c.not ?? false,
    after: resolveSteps(c.after, params, `${where}.after`),
    weight: c.weight ?? 1,
  };
  if (within !== undefined) out.within = within;
  return out;
}

const text = (value: Json): string => (typeof value === 'string' ? value : JSON.stringify(value));

/** Joins debrief blocks as Markdown paragraphs. */
function joinBlocks(blocks: string[]): string {
  return blocks.map((b) => b.replace(/\s+$/, '')).join('\n\n') + '\n';
}

export function variantOf(item: Item, seed: number, params: Params = resolveParams(item, seed)): Variant {
  const w = item.world;
  const hints: string[] = [];
  item.hints.forEach((h, i) => {
    if (typeof h === 'string') hints.push(text(substituteString(h, params, `hints[${i}]`)));
    else if (matches(h.when, params)) hints.push(text(substituteString(h.text, params, `hints[${i}]`)));
  });
  const solutions: Solution[] = [];
  item.solutions.forEach((s, i) => {
    if (Array.isArray(s)) solutions.push({ steps: resolveSteps(s, params, `solutions[${i}]`) });
    else if (matches(s.when, params)) solutions.push({ name: text(substituteString(s.name, params, `solutions[${i}].name`)), steps: resolveSteps(s.steps, params, `solutions[${i}].steps`) });
  });
  const debrief =
    typeof item.debrief === 'string'
      ? text(substituteString(item.debrief, params, 'debrief'))
      : joinBlocks(item.debrief.flatMap((b, i) => (matches(b.when, params) ? [text(substituteString(b.text, params, `debrief[${i}]`))] : [])));
  const v: Variant = {
    item,
    seed,
    params,
    topology: w.topology,
    topologyParams: w.topologyParams ?? {},
    setup: resolveSteps(w.setup, params, 'world.setup'),
    ticket: text(substituteString(item.ticket, params, 'ticket')),
    hints,
    checks: item.checks.flatMap((c, i) => (matches(c.when, params) ? [resolveCheck(c, params, `checks[${i}]`)] : [])),
    solutions,
    debrief,
  };
  if (w.startTime !== undefined) v.startTime = parseStartTime(w.startTime);
  if (w.entry) v.entry = { ...w.entry };
  return v;
}
