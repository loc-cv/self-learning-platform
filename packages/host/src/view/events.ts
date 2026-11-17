// The host's reading of the trace (PLAN.md §6.5, docs/ARCHITECTURE.md §2.13): each command line an
// interactive shell ran, as an input event on its machine, from its `shell.command` record and,
// once it ended, its `shell.command.done` (shell/bash.ts). Pure: a function of the records alone.

import { SESSION_SETUP_LINE } from '../transcript/session.ts';
import type { Json, TraceRecord, ViewEvent, ViewTone } from '@simlab/kernel';

/** The view id of a machine (the provider's entity id). */
export const machineViewId = (id: string): string => `host/machine/${id}`;

/** The trace kinds of the host's components, and what the views make of each. */
export const HOST_TRACE_KINDS = {
  'shell.command': 'an input event per command line',
  'shell.command.done': 'the end of its command line: `until` and the exit status',
} as const;

type Data = Record<string, Json>;
const dataOf = (r: TraceRecord): Data => (r.data !== null && typeof r.data === 'object' && !Array.isArray(r.data) ? (r.data as Data) : {});
const text = (v: Json | undefined): string => (typeof v === 'string' ? v : '');

export function hostEvents(records: readonly TraceRecord[]): ViewEvent[] {
  const done = new Map<number, TraceRecord>();
  for (const r of records) if (r.kind === 'shell.command.done' && r.causes?.[0] !== undefined) done.set(r.causes[0], r);
  const out: ViewEvent[] = [];
  for (const r of records) {
    if (r.kind !== 'shell.command') continue;
    const d = dataOf(r);
    // A plain session's own setup line (scenario steps, transcripts): nobody's command.
    if (text(d.line) === SESSION_SETUP_LINE) continue;
    const end = done.get(r.id);
    const status = end ? dataOf(end).status : undefined;
    const tone: ViewTone = typeof status === 'number' && status !== 0 ? 'bad' : 'neutral';
    const e: ViewEvent = {
      id: r.id,
      t: r.t,
      actor: `${text(d.user)}@${text(d.hostname)}`,
      text: text(d.line),
      about: [machineViewId(text(d.machine))],
      level: 'key',
      tone,
      input: true,
      causes: [],
    };
    if (end) {
      e.until = end.t;
      e.items = [{ label: 'Exit status', value: String(status), tone }];
    }
    out.push(e);
  }
  return out;
}
