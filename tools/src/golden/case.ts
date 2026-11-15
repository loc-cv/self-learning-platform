// The golden case format (docs/FIDELITY.md §6.2): a declarative file that says what to set up,
// what to run against the oracle and what to keep. Cases live in fixtures/golden/cases/; their
// fixtures in fixtures/golden/<version>/ under the same relative path.

import { parse as parseYaml } from 'yaml';
import type { TableKind } from './normalize.ts';

export interface RunStep {
  run: string;
  /** Standard input for the command. */
  stdin?: string;
  /** How to re-align the output; default from the command (kubectl get without -o, kubectl describe). */
  table?: TableKind | 'none';
  /** Run on a pseudo-terminal of `cols` columns; stdout and stderr then arrive interleaved as `output`. */
  tty?: boolean;
  cols?: number;
  /** The output shows fields that KWOK, not a real kubelet, wrote (docs/FIDELITY.md §6.4). */
  kwok?: boolean;
  /** The real tool prints these lines in random order (Go map iteration): sort all but the first. */
  unorderedLines?: boolean;
  /** Age columns (0-based) of a table printed without its header (--no-headers). */
  ageColumns?: number[];
  /** Placement in this output was a scheduling tie between node01 and node02: write <<node>>. */
  anyWorker?: boolean;
  /** Keep the output as captured (help text, generators: nothing volatile, and prose the rules could misread). */
  normalize?: boolean;
}

/** Run, not recorded, must exit 0. */
export interface DoStep {
  do: string;
  stdin?: string;
}

/** Run every half second until stdout matches `match`, at most `timeout` seconds. Not recorded. */
export interface UntilStep {
  until: string;
  match: string;
  timeout?: number;
}

/** `kubectl get <ref> -o json` for each ref, normalized and recorded as objects. */
export interface ObjectsStep {
  objects: string[];
  anyWorker?: boolean;
}

export interface SleepStep {
  sleep: number;
}

/**
 * One HTTP request straight to the API server as the admin identity, bypassing kubectl: what the
 * request pipeline answers (status code, warnings, body). `request` is `<METHOD> <path?query>`;
 * `body` is YAML or JSON and is sent as JSON, or verbatim with `raw: true` (duplicate keys,
 * malformed JSON).
 */
export interface RequestStep {
  request: string;
  body?: string;
  raw?: boolean;
  /** Default application/json; a PATCH names its patch type (application/merge-patch+json). */
  contentType?: string;
  /** Keep only these top-level keys of the response body (a discovery list too big to keep whole). */
  keep?: string[];
}

export type Step = RunStep | DoStep | UntilStep | ObjectsStep | SleepStep | RequestStep;

export interface GoldenCase {
  description: string;
  /** False for the client-only oracle: kubectl with no server at all. */
  server: boolean;
  /** Run KWOK so Nodes stay Ready and Pods reach Running. Default: with a server. */
  kwok: boolean;
  /** Files written into the working directory (the learner's home) before setup. */
  files: Record<string, string>;
  setup: (DoStep | UntilStep | SleepStep)[];
  steps: Step[];
}

const STEP_KEYS: Record<string, string[]> = {
  run: ['run', 'stdin', 'table', 'tty', 'cols', 'kwok', 'normalize', 'anyWorker', 'unorderedLines', 'ageColumns'],
  do: ['do', 'stdin'],
  until: ['until', 'match', 'timeout'],
  objects: ['objects', 'anyWorker'],
  sleep: ['sleep'],
  request: ['request', 'body', 'raw', 'contentType', 'keep'],
};

function checkStep(s: unknown, where: string, allowed: string[]): Step {
  if (s === null || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${where}: a step is a mapping`);
  const kind = Object.keys(STEP_KEYS).find((k) => k in s);
  if (!kind || !allowed.includes(kind)) throw new Error(`${where}: expected one of ${allowed.join(', ')}`);
  for (const k of Object.keys(s)) if (!(STEP_KEYS[kind] as string[]).includes(k)) throw new Error(`${where}: unknown key "${k}" in a ${kind} step`);
  const st = s as Record<string, unknown>;
  if (kind === 'request' && !(typeof st.request === 'string' && /^(GET|POST|PUT|PATCH|DELETE) \/\S*$/.test(st.request))) throw new Error(`${where}: request is "<METHOD> <path>"`);
  if (kind === 'run' || kind === 'do' || kind === 'until') if (typeof st[kind] !== 'string') throw new Error(`${where}: ${kind} must be a string`);
  if (kind === 'until' && typeof st.match !== 'string') throw new Error(`${where}: until needs match`);
  if (kind === 'objects' && !(Array.isArray(st.objects) && st.objects.every((o) => typeof o === 'string'))) throw new Error(`${where}: objects is a list of strings`);
  if (kind === 'run' && st.table !== undefined && !['get', 'describe', 'none'].includes(st.table as string)) throw new Error(`${where}: table is get, describe or none`);
  return s as Step;
}

export function parseCase(text: string, where: string): GoldenCase {
  const raw = parseYaml(text) as Record<string, unknown>;
  const known = ['description', 'server', 'kwok', 'files', 'setup', 'steps'];
  for (const k of Object.keys(raw)) if (!known.includes(k)) throw new Error(`${where}: unknown key "${k}"`);
  if (typeof raw.description !== 'string') throw new Error(`${where}: description is required`);
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new Error(`${where}: steps is a non-empty list`);
  const server = raw.server === undefined ? true : raw.server === true;
  return {
    description: raw.description,
    server,
    kwok: raw.kwok === undefined ? server : raw.kwok === true,
    files: (raw.files ?? {}) as Record<string, string>,
    setup: ((raw.setup ?? []) as unknown[]).map((s, i) => checkStep(s, `${where}: setup[${i}]`, ['do', 'until', 'sleep']) as DoStep | UntilStep | SleepStep),
    steps: raw.steps.map((s, i) => checkStep(s, `${where}: steps[${i}]`, Object.keys(STEP_KEYS))),
  };
}

/** The table kind implied by a command: `kubectl get` printing a table, or `kubectl describe`. */
export function defaultTable(command: string): TableKind | undefined {
  if (/[|;&<>`$]/.test(command)) return undefined;
  const words = command.trim().split(/\s+/);
  if (words[0] !== 'kubectl') return undefined;
  if (words[1] === 'describe') return 'describe';
  if (words[1] !== 'get') return undefined;
  const o = words.findIndex((w) => w === '-o' || w === '--output' || w.startsWith('-o') || w.startsWith('--output='));
  if (o < 0) return 'get';
  const w = words[o] as string;
  const value = w === '-o' || w === '--output' ? words[o + 1] : w.replace(/^--output=|^-o=?/, '');
  return value === 'wide' || value?.startsWith('custom-columns') ? 'get' : undefined;
}
