// npm run gaps:summary [-- --all] [--data DIR]
// npm run gaps:summary -- --handle <key> [--handle <key>…] --note <what was decided>
//
// The gap log grouped by key, most frequent first (docs/FIDELITY.md §4.4). prompts/R3 works from
// this view, never from the raw file. A triage run marks the groups it dealt with: a mark is one
// line in data/gaps.handled.jsonl (key, time, note), next to the log and as local as it is. A
// group is open again as soon as the log holds a record newer than its latest mark, so a fix
// that did not hold, or a deferred gap I keep hitting, comes back by itself.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** The fields of a gap record (docs/FIDELITY.md §4.4) this tool reads. */
export interface GapLine {
  kind: string;
  program: string;
  what: string;
  commandLine: string;
  key: string;
  at: string;
  context?: { item?: string };
}

export interface HandledMark {
  key: string;
  /** Wall-clock time of the mark, ISO 8601. */
  at: string;
  note: string;
}

export interface GapGroup {
  key: string;
  kind: string;
  program: string;
  what: string;
  /** Records in the log. */
  count: number;
  /** Records newer than the latest mark; equal to `count` for a group never marked. */
  open: number;
  first: string;
  last: string;
  /** Distinct command lines, in order of first use. */
  commandLines: string[];
  /** Content items the gap was hit in. */
  items: string[];
  handled?: HandledMark;
}

/** One JSON object per line; blank lines are skipped and a broken line is an error naming it. */
export function parseJsonl<T>(text: string, name: string): T[] {
  const out: T[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      throw new Error(`${name}: line ${i + 1} is not JSON`);
    }
  });
  return out;
}

/** Groups by key; open groups first, then by count, then by key. */
export function groupGaps(records: readonly GapLine[], marks: readonly HandledMark[] = []): GapGroup[] {
  const latest = new Map<string, HandledMark>();
  for (const m of marks) {
    const seen = latest.get(m.key);
    if (!seen || m.at > seen.at) latest.set(m.key, m);
  }
  const groups = new Map<string, GapGroup>();
  for (const r of records) {
    let g = groups.get(r.key);
    if (!g) {
      const handled = latest.get(r.key);
      g = { key: r.key, kind: r.kind, program: r.program, what: r.what, count: 0, open: 0, first: r.at, last: r.at, commandLines: [], items: [], ...(handled ? { handled } : {}) };
      groups.set(r.key, g);
    }
    g.count++;
    if (!g.handled || r.at > g.handled.at) g.open++;
    if (r.at < g.first) g.first = r.at;
    if (r.at > g.last) g.last = r.at;
    if (!g.commandLines.includes(r.commandLine)) g.commandLines.push(r.commandLine);
    const item = r.context?.item;
    if (item !== undefined && !g.items.includes(item)) g.items.push(item);
  }
  return [...groups.values()].sort((a, b) => Number(b.open > 0) - Number(a.open > 0) || b.open - a.open || b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ');
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** The report: one block per group. Handled groups only with `all`. */
export function formatSummary(groups: readonly GapGroup[], opts: { all?: boolean } = {}): string {
  const open = groups.filter((g) => g.open > 0);
  const handled = groups.filter((g) => g.open === 0);
  const lines: string[] = [];
  const block = (g: GapGroup): void => {
    const again = g.handled && g.open > 0 ? ` (${g.open} since it was handled: ${g.handled.note})` : '';
    lines.push(`${String(g.open > 0 ? g.open : g.count).padStart(4)}  ${g.key}${again}`);
    lines.push(`      ${g.kind} · ${g.program} · ${clip(g.what, 100)} · ${g.first.slice(0, 10)}${g.last.slice(0, 10) !== g.first.slice(0, 10) ? ` to ${g.last.slice(0, 10)}` : ''}${g.items.length > 0 ? ` · ${g.items.join(', ')}` : ''}`);
    for (const c of g.commandLines.slice(0, 3)) lines.push(`      $ ${clip(c, 100)}`);
    if (g.commandLines.length > 3) lines.push(`      … and ${g.commandLines.length - 3} more command lines`);
    if (g.handled && g.open === 0) lines.push(`      handled ${g.handled.at.slice(0, 10)}: ${g.handled.note}`);
  };
  const total = open.reduce((n, g) => n + g.open, 0);
  lines.push(open.length === 0 ? 'No open gap groups.' : `${open.length} open gap group${open.length === 1 ? '' : 's'}, ${total} record${total === 1 ? '' : 's'}:`);
  open.forEach(block);
  if (handled.length > 0) {
    lines.push('');
    if (opts.all) {
      lines.push(`${handled.length} handled:`);
      handled.forEach(block);
    } else lines.push(`${handled.length} handled group${handled.length === 1 ? '' : 's'} not shown (--all).`);
  }
  return `${lines.join('\n')}\n`;
}

const USAGE = 'usage: npm run gaps:summary -- [--all] [--data DIR] [--handle KEY… --note TEXT]\n';

function main(argv: string[]): number {
  let data = join(REPO, 'data');
  let all = false;
  let note: string | undefined;
  const handle: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (): string | undefined => argv[++i];
    if (a === '--all') all = true;
    else if (a === '--data' || a === '--handle' || a === '--note') {
      const v = value();
      if (v === undefined) {
        process.stderr.write(`${a} needs a value\n${USAGE}`);
        return 2;
      }
      if (a === '--data') data = resolve(v);
      else if (a === '--handle') handle.push(v);
      else note = v;
    } else {
      process.stderr.write(`unknown argument ${a}\n${USAGE}`);
      return 2;
    }
  }
  const logFile = join(data, 'gaps.jsonl');
  const marksFile = join(data, 'gaps.handled.jsonl');
  const records = existsSync(logFile) ? parseJsonl<GapLine>(readFileSync(logFile, 'utf8'), logFile) : [];
  const marks = existsSync(marksFile) ? parseJsonl<HandledMark>(readFileSync(marksFile, 'utf8'), marksFile) : [];
  if (handle.length > 0 || note !== undefined) {
    if (handle.length === 0 || note === undefined || note.trim() === '') {
      process.stderr.write(`marking a group needs --handle KEY and --note TEXT\n${USAGE}`);
      return 2;
    }
    const keys = new Set(records.map((r) => r.key));
    const unknown = handle.filter((k) => !keys.has(k));
    if (unknown.length > 0) {
      process.stderr.write(`no gap record has the key ${unknown.map((k) => JSON.stringify(k)).join(', ')}\n`);
      return 1;
    }
    const at = new Date().toISOString();
    mkdirSync(data, { recursive: true });
    appendFileSync(marksFile, handle.map((key) => `${JSON.stringify({ key, at, note } satisfies HandledMark)}\n`).join(''));
    process.stdout.write(`marked ${handle.length} group${handle.length === 1 ? '' : 's'} handled\n`);
    return 0;
  }
  process.stdout.write(formatSummary(groupGaps(records, marks), { all }));
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
