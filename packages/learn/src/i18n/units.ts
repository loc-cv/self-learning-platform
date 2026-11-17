// The text units of an item (docs/SCENARIO_FORMAT.md §13, docs/LEARNING_MODEL.md §4): every piece
// of English prose a sidecar may translate, with its key, where it sits in the item and the hash
// a translation records.

import type { Figure, Note } from '../figure/types.ts';
import type { AnyItem, CheckDecl } from '../item/types.ts';
import { sha256Hex } from './sha256.ts';

export interface TextUnit {
  /** `title`, `hints.0`, `debrief.2.caption`, `steps.3.checks.bumped.title`, … */
  key: string;
  /** The English text as written, before placeholder substitution. */
  text: string;
  /** Where the string is in the item: object keys and array indexes. */
  path: (string | number)[];
}

/** CRLF to LF, trailing whitespace off every line, leading and trailing blank lines dropped. */
export function normalizeText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** `sha256:` and the first 16 hexadecimal digits of the SHA-256 of the normalized text. */
export function sourceHash(text: string): string {
  return `sha256:${sha256Hex(normalizeText(text)).slice(0, 16)}`;
}

type Path = (string | number)[];

function noteUnits(notes: readonly Note[] | undefined, key: string, path: Path, out: TextUnit[]): void {
  (notes ?? []).forEach((n, m) => out.push({ key: `${key}.notes.${m}`, text: n.text, path: [...path, 'notes', m, 'text'] }));
}

function figureUnits(f: Figure, key: string, path: Path, out: TextUnit[]): void {
  out.push({ key: `${key}.caption`, text: f.caption, path: [...path, 'caption'] }, { key: `${key}.alt`, text: f.alt, path: [...path, 'alt'] });
  noteUnits(f.notes, key, path, out);
  if (f.kind === 'compare') {
    for (const side of ['left', 'right'] as const) {
      const title = f[side].title;
      if (title !== undefined) out.push({ key: `${key}.${side}.title`, text: title, path: [...path, side, 'title'] });
    }
  } else if (f.kind === 'scene') {
    f.frames.forEach((fr, m) => {
      out.push({ key: `${key}.frames.${m}.caption`, text: fr.caption, path: [...path, 'frames', m, 'caption'] });
      noteUnits(fr.notes, `${key}.frames.${m}`, [...path, 'frames', m], out);
    });
  } else if (f.kind === 'diagram') {
    f.entities.forEach((e, m) => out.push({ key: `${key}.entities.${e.id}.label`, text: e.label, path: [...path, 'entities', m, 'label'] }));
  }
}

/** A Markdown field or a list of blocks: `ticket`, or `ticket.<n>` and the figures' units. */
function proseUnits(value: string | readonly ({ text: string } | { figure: Figure })[], field: string, out: TextUnit[]): void {
  if (typeof value === 'string') {
    out.push({ key: field, text: value, path: [field] });
    return;
  }
  value.forEach((b, n) => {
    if ('figure' in b) figureUnits(b.figure, `${field}.${n}`, [field, n, 'figure'], out);
    else out.push({ key: `${field}.${n}`, text: b.text, path: [field, n, 'text'] });
  });
}

function checkUnits(checks: readonly CheckDecl[] | undefined, key: string, path: Path, out: TextUnit[]): void {
  (checks ?? []).forEach((c, i) => out.push({ key: `${key}checks.${c.id}.title`, text: c.title, path: [...path, 'checks', i, 'title'] }));
}

/** Every text unit of an item, in the order the item shows them. */
export function textUnits(item: AnyItem): TextUnit[] {
  const out: TextUnit[] = [{ key: 'title', text: item.title, path: ['title'] }];
  if (item.kind === 'exam') return out;
  if (item.kind === 'lesson') {
    item.steps.forEach((s, n) => {
      const key = `steps.${n}`;
      if ('text' in s) out.push({ key, text: s.text, path: ['steps', n, 'text'] });
      else if ('figure' in s) figureUnits(s.figure, key, ['steps', n, 'figure'], out);
      else if ('predict' in s) {
        const base: Path = ['steps', n, 'predict'];
        out.push({ key: `${key}.prompt`, text: s.predict.prompt, path: [...base, 'prompt'] });
        (s.predict.choices ?? []).forEach((c, m) => out.push({ key: `${key}.choices.${m}`, text: c, path: [...base, 'choices', m] }));
        out.push({ key: `${key}.explain`, text: s.predict.explain, path: [...base, 'explain'] });
      } else {
        const base: Path = ['steps', n, 'task'];
        out.push({ key: `${key}.text`, text: s.task.text, path: [...base, 'text'] });
        (s.task.hints ?? []).forEach((h, m) => out.push({ key: `${key}.hints.${m}`, text: h, path: [...base, 'hints', m] }));
        checkUnits(s.task.checks, `${key}.`, base, out);
      }
    });
    return out;
  }
  if (item.kind === 'card') {
    out.push({ key: 'prompt', text: item.prompt, path: ['prompt'] });
    if (item.figure) figureUnits(item.figure, 'figure', ['figure'], out);
    (item.choices ?? []).forEach((c, m) => out.push({ key: `choices.${m}`, text: c, path: ['choices', m] }));
    out.push({ key: 'answer', text: item.answer, path: ['answer'] });
    checkUnits(item.checks, '', [], out);
    return out;
  }
  proseUnits(item.ticket, 'ticket', out);
  item.hints.forEach((h, n) => out.push(typeof h === 'string' ? { key: `hints.${n}`, text: h, path: ['hints', n] } : { key: `hints.${n}`, text: h.text, path: ['hints', n, 'text'] }));
  checkUnits(item.checks, '', [], out);
  item.solutions.forEach((s, n) => {
    if (!Array.isArray(s)) out.push({ key: `solutions.${n}.name`, text: s.name, path: ['solutions', n, 'name'] });
  });
  proseUnits(item.debrief, 'debrief', out);
  return out;
}
