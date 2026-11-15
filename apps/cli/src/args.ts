// Command-line arguments of the tools: `--name value`, `--name=value`, flags, and positionals.

import { UsageError } from './world.ts';

export interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
  positionals: string[];
}

/** `valued` options take a value; everything else starting with `--` is a flag. `-c` is `--command`. */
export function parseArgs(argv: readonly string[], valued: readonly string[], flags: readonly string[]): Parsed {
  const out: Parsed = { values: new Map(), flags: new Set(), positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i] as string;
    if (a === '-c') a = '--command';
    if (!a.startsWith('--') || a === '--') {
      out.positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (valued.includes(name)) {
      const v = eq < 0 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined) throw new UsageError(`--${name} needs a value`);
      out.values.set(name, v);
    } else if (flags.includes(name) && eq < 0) out.flags.add(name);
    else throw new UsageError(`unknown option ${a}`);
  }
  return out;
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A virtual duration: `500ms`, `30s`, `2m`, `1h`, `1d`, or a bare number of seconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(text.trim());
  if (!m) throw new UsageError(`bad duration '${text}' (use e.g. 500ms, 30s, 2m, 1h)`);
  return Math.round(Number(m[1]) * (UNITS[m[2] ?? 's'] as number));
}

export function parseSeed(text: string | undefined): number {
  if (text === undefined) return 1;
  if (!/^\d+$/.test(text)) throw new UsageError(`bad seed '${text}': a non-negative integer`);
  return Number(text);
}
