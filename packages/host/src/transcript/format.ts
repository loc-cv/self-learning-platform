// The transcript format: readable files that specify a command's behavior as a terminal shows it
// (PLAN.md §12). Every later phase writes its command tests in it. Specified in
// docs/TRANSCRIPTS.md; in short:
//
//   # A title, then comment lines. `# tags:` and `# cols:` are read.
//   # tags: golden-verified
//   % mkdir d                  a setup command: run, output ignored, must succeed
//   $ ls d nope                a command; continuation lines start with "> "
//   ls: cannot access 'nope': No such file or directory
//   d:
//   [exit 2]                   the exit status, when it is not 0
//   @editor <<EOF              what the next editor (vim, nano, kubectl edit's) saves, up to
//   new content                the closing word; `@editor :q!` closes the next one without
//   EOF                        saving; given before the command that opens it
//
// Expected output is every line up to the next `$`, `%`, `#` or `@editor` line, blank lines
// included: steps are separated by comment lines, not blank ones. An output line that starts
// with one of `$ `, `% `, `> `, `#`, `[exit `, `@editor` or `\` is written with a leading
// backslash. Output that does not end in a newline ends with ` (no-eol)`.

export interface TranscriptStep {
  /** `setup` steps run like commands, but only their success is checked. */
  kind: 'command' | 'setup';
  /** The command as typed, lines joined with newlines. */
  command: string;
  /** Expected terminal output, newlines as LF. */
  output: string;
  status: number;
  /** 1-based line of the step in the file. */
  line: number;
  /**
   * Answers for the editors opened from here on, queued before the step runs (`@editor` lines
   * above it): the content to save, or null to close without saving. Editors with nothing queued
   * close without saving.
   */
  editors?: (string | null)[];
}

export interface Transcript {
  /** Leading comment lines, without the `# `. */
  header: string[];
  tags: string[];
  cols: number;
  steps: TranscriptStep[];
}

const ESCAPE = /^(\$ |% |> |#|\[exit |@editor(?: |$)|\\)/;
const EDITOR = /^@editor(?: |$)/;

/**
 * An `@editor` directive at `lines[i]`: the answer and the index after it (throws when malformed).
 * `@editor <<WORD` (or `<<'WORD'`) takes the lines up to WORD, each ending in a newline.
 */
function parseEditor(lines: readonly string[], i: number): { answer: string | null; next: number } {
  const arg = (lines[i] as string).slice('@editor'.length).trim();
  if (arg === ':q!') return { answer: null, next: i + 1 };
  const m = /^<<\s*'?(\w+)'?$/.exec(arg);
  if (!m) throw new Error(`transcript line ${i + 1}: expected "@editor <<WORD" or "@editor :q!", got ${JSON.stringify(lines[i])}`);
  const body: string[] = [];
  let j = i + 1;
  for (; j < lines.length && lines[j] !== m[1]; j++) body.push(lines[j] as string);
  if (j >= lines.length) throw new Error(`transcript line ${i + 1}: @editor: no closing ${m[1] as string}`);
  return { answer: body.map((l) => `${l}\n`).join(''), next: j + 1 };
}

export function parseTranscript(text: string): Transcript {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const t: Transcript = { header: [], tags: [], cols: 80, steps: [] };
  let i = 0;
  for (; i < lines.length && (lines[i] as string).startsWith('#'); i++) {
    const h = (lines[i] as string).replace(/^# ?/, '');
    t.header.push(h);
    const tags = /^tags:\s*(.*)$/.exec(h);
    if (tags) t.tags.push(...(tags[1] as string).split(',').map((s) => s.trim()).filter((s) => s !== ''));
    const cols = /^cols:\s*(\d+)$/.exec(h);
    if (cols) t.cols = Number(cols[1]);
  }
  let editors: (string | null)[] = [];
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.startsWith('#') || line === '') {
      i++;
      continue;
    }
    if (EDITOR.test(line)) {
      const e = parseEditor(lines, i);
      editors.push(e.answer);
      i = e.next;
      continue;
    }
    if (!line.startsWith('$ ') && !line.startsWith('% ')) throw new Error(`transcript line ${i + 1}: expected "$ ", "% " or "@editor", got ${JSON.stringify(line)}`);
    const step: TranscriptStep = { kind: line.startsWith('$ ') ? 'command' : 'setup', command: line.slice(2), output: '', status: 0, line: i + 1 };
    if (editors.length > 0) {
      step.editors = editors;
      editors = [];
    }
    i++;
    while (i < lines.length && (lines[i] as string).startsWith('> ')) step.command += `\n${(lines[i++] as string).slice(2)}`;
    const out: string[] = [];
    while (i < lines.length) {
      const l = lines[i] as string;
      if (l.startsWith('$ ') || l.startsWith('% ') || l.startsWith('#') || EDITOR.test(l)) break;
      const exit = /^\[exit (\d+)\]$/.exec(l);
      if (exit) {
        step.status = Number(exit[1]);
        i++;
        break;
      }
      out.push(l.startsWith('\\') ? l.slice(1) : l);
      i++;
    }
    // Blank lines after a command are output; after a setup step they only separate.
    while (out.length > 0 && out[out.length - 1] === '' && step.kind === 'setup') out.pop();
    if (out.length > 0) {
      const last = out[out.length - 1] as string;
      if (last.endsWith(' (no-eol)')) {
        out[out.length - 1] = last.slice(0, -' (no-eol)'.length);
        step.output = out.join('\n');
      } else step.output = `${out.join('\n')}\n`;
    }
    t.steps.push(step);
  }
  if (editors.length > 0) throw new Error('transcript: @editor after the last command');
  return t;
}

/** Writes the expected-output block of a step as it appears in a transcript file. */
export function formatOutput(output: string, status: number): string[] {
  const lines: string[] = [];
  if (output !== '') {
    const noEol = !output.endsWith('\n');
    const body = (noEol ? output : output.slice(0, -1)).split('\n');
    body.forEach((l, k) => {
      let s = ESCAPE.test(l) ? `\\${l}` : l;
      if (noEol && k === body.length - 1) s += ' (no-eol)';
      lines.push(s);
    });
  }
  if (status !== 0) lines.push(`[exit ${status}]`);
  return lines;
}

/**
 * Rewrites the expected output of each command step in `text` (for the capture tool), keeping the
 * header, comments and setup steps as they are.
 */
export function replaceOutputs(text: string, results: readonly { output: string; status: number }[]): string {
  const lines = text.split('\n');
  const hadNl = lines[lines.length - 1] === '';
  if (hadNl) lines.pop();
  const out: string[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length && (lines[i] as string).startsWith('#')) out.push(lines[i++] as string);
  while (i < lines.length) {
    const line = lines[i] as string;
    if (EDITOR.test(line)) {
      const e = parseEditor(lines, i);
      out.push(...lines.slice(i, e.next));
      i = e.next;
      continue;
    }
    if (!line.startsWith('$ ') && !line.startsWith('% ')) {
      out.push(line);
      i++;
      continue;
    }
    const isCommand = line.startsWith('$ ');
    out.push(line);
    i++;
    while (i < lines.length && (lines[i] as string).startsWith('> ')) out.push(lines[i++] as string);
    const start = i;
    while (i < lines.length) {
      const l = lines[i] as string;
      if (l.startsWith('$ ') || l.startsWith('% ') || l.startsWith('#') || EDITOR.test(l)) break;
      i++;
      if (/^\[exit \d+\]$/.test(l)) break;
    }
    if (isCommand) {
      const r = results[k++];
      if (!r) throw new Error('fewer results than commands');
      out.push(...formatOutput(r.output, r.status));
    } else out.push(...lines.slice(start, i));
  }
  return out.join('\n') + (hadNl ? '\n' : '');
}
