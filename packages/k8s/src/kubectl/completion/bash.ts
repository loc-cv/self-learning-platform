// The shell side of kubectl's completion: what the script `kubectl completion bash` prints does
// with each Tab, as bash runs it (complete -o default -F __start_kubectl kubectl).
//   upstream: vendor/github.com/spf13/cobra/bash_completionsV2.go (the script):
//     __start_kubectl: words from `_init_completion -n =:` (bash-completion keeps `=` and `:` inside
//       words), truncated at the cursor's word;
//     __kubectl_get_completion_results: `${words[0]} __complete ${args[*]}` through eval, an extra
//       '' when the word is empty and the previous one does not end in `=`, cur cut after `=` for
//       `--flag=value`; directive=${out##*:}, out=${out%:*} (the Go template's %% is one %);
//     __kubectl_process_completion_results: Error gives nothing, NoSpace is compopt -o nospace,
//       NoFileComp is compopt +o default, FilterFileExt is `_filedir "ext|ext|"`, FilterDirs
//       `_filedir -d` (in the given directory);
//     __kubectl_handle_standard_completion_case: without descriptions printf %q and compgen -W;
//       with them the candidates whose escaped name starts with cur, one left is its escaped name,
//       several are formatted by __kubectl_format_comp_descriptions (names padded to the longest,
//       `  (description)` cut to COLUMNS with `…`);
//     __kubectl_handle_special_char: the part of cur up to its last `:` or `=` is removed from
//       each candidate (readline's word starts after it).
//   reference: bash-completion 2.11 _filedir (`compgen -f -X "!*.@($ext|${ext^^})" -o plusdirs`,
//     compopt -o filenames), /usr/share/bash-completion/bash_completion on the workstation
//   reference: bash 5.2.21 printf %q (lib/sh/shquote.c sh_backslash_quote), checked character by
//     character on the workstation 2026-11-16; COMP_WORDBREAKS (bash.ts WORD_BREAKS in tty/complete.ts)
//   reference: fixtures/reference/bash/kubectl-completion.json (the real script on a pty)

import type { CompletionResult, Fs, ProgramCompletion } from '@simlab/host';
import { DIRECTIVE } from './cobra.ts';

/** What `kubectl __complete <args>` printed. */
export type RunComplete = (args: string[]) => string;

/** Characters printf %q escapes with a backslash anywhere, and those only at the start. */
const Q_ANY = ' !"$&\'()*,;<>?[\\]^`{|}';
const Q_START = '#~';

/** bash printf %q */
export function shellQuote(s: string): string {
  if (s === '') return "''";
  const control = (c: string) => c.charCodeAt(0) < 0x20 || c === '\x7f';
  if ([...s].some(control)) {
    // $'…' form for control characters.
    const named: Record<string, string> = { '\t': '\\t', '\n': '\\n', '\r': '\\r' };
    let esc = '';
    for (const c of s) {
      if (c === '\\' || c === "'") esc += `\\${c}`;
      else if (control(c)) esc += named[c] ?? `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`;
      else esc += c;
    }
    return `$'${esc}'`;
  }
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    out += Q_ANY.includes(c) || (i === 0 && Q_START.includes(c)) ? `\\${c}` : c;
  }
  return out;
}

/** compgen -W's expansion of one word: quote removal (the words come from printf %q). */
function unquote(w: string): string {
  if (w.startsWith("$'")) return w;
  if (w === "''") return '';
  return w.replace(/\\(.)/g, '$1');
}

const chars = (s: string): number => [...s].length;

/**
 * The words bash-completion's `_get_comp_words_by_ref -n =:` gives for the command up to the
 * cursor: split at blanks and at COMP_WORDBREAKS other than `=` and `:` (each such run is a word
 * of its own); quotes protect what they enclose and stay in the word.
 */
export function compWords(line: string): { words: string[]; open: boolean } {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  let q: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (q) {
      cur += ch;
      if (ch === q) q = undefined;
      else if (q === '"' && ch === '\\' && i + 1 < line.length) cur += line[++i];
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
      continue;
    }
    if ('@><;|&('.includes(ch)) {
      if (inWord) words.push(cur);
      words.push(ch);
      cur = '';
      inWord = false;
      continue;
    }
    inWord = true;
    cur += ch;
    if (ch === '\\' && i + 1 < line.length) cur += line[++i];
    else if (ch === "'" || ch === '"') q = ch;
  }
  words.push(inWord ? cur : '');
  return { words, open: q !== undefined };
}

/** Quote removal as eval does it, for a word without expansions. */
function evalWord(w: string): string {
  let out = '';
  let q: string | undefined;
  for (let i = 0; i < w.length; i++) {
    const ch = w[i] as string;
    if (q) {
      if (ch === q) q = undefined;
      else if (q === '"' && ch === '\\' && i + 1 < w.length && '$`"\\\n'.includes(w[i + 1] as string)) out += w[++i];
      else out += ch;
    } else if (ch === '\\' && i + 1 < w.length) out += w[++i];
    else if (ch === "'" || ch === '"') q = ch;
    else out += ch;
  }
  return out;
}

/** compgen -f / -d over the file system: paths starting with `cur`, directories flagged. */
function compgenFiles(fs: Fs, home: string | undefined, cur: string, keep: (name: string, dir: boolean) => boolean): { matches: string[]; dirs: boolean[] } {
  const slash = cur.lastIndexOf('/');
  const dirPart = slash < 0 ? '' : cur.slice(0, slash + 1);
  const base = slash < 0 ? cur : cur.slice(slash + 1);
  let lookup = dirPart === '' ? '.' : dirPart;
  if (dirPart.startsWith('~/')) {
    if (home === undefined) return { matches: [], dirs: [] };
    lookup = home + dirPart.slice(1);
  }
  let names: string[];
  try {
    names = fs.readdir(lookup);
  } catch {
    return { matches: [], dirs: [] };
  }
  const matches: string[] = [];
  const dirs: boolean[] = [];
  for (const n of names) {
    if (!n.startsWith(base)) continue;
    const full = lookup.endsWith('/') ? lookup + n : `${lookup}/${n}`;
    let dir: boolean;
    try {
      dir = fs.stat(full).type === 'dir';
    } catch {
      dir = false;
    }
    if (!keep(n, dir)) continue;
    matches.push(dirPart + n);
    dirs.push(dir);
  }
  return { matches, dirs };
}

/** bash-completion's _filedir with an extension list (`json|yaml|yml|`) or -d. */
function filedir(fs: Fs, home: string | undefined, cur: string, exts: string[] | 'dirs'): CompletionResult | undefined {
  // _tilde: `~user` without a slash completes user names (left to bash's own completion here).
  if (/^~[^/]*$/.test(cur)) return undefined;
  let keep: (name: string, dir: boolean) => boolean;
  if (exts === 'dirs') keep = (_n, dir) => dir;
  else {
    // !*.@(json|yaml|yml||JSON|YAML|YML|) with -o plusdirs; the empty alternative (from the
    // trailing `|`) lets a name ending in a dot through.
    const alts = new Set([...exts, '', ...exts.map((e) => e.toUpperCase())]);
    keep = (n, dir) => {
      if (dir) return true;
      const i = n.lastIndexOf('.');
      return i >= 0 && [...alts].some((a) => n.endsWith(`.${a}`));
    };
  }
  const r = compgenFiles(fs, home, cur, keep);
  if (r.matches.length === 0) return undefined;
  return { ...sortResult(r.matches, r.dirs), filenames: true };
}

/** readline sorts the matches and drops duplicates (rl_sort_completion_matches, completion_ignore_duplicates). */
function sortResult(matches: string[], dirs?: boolean[]): { matches: string[]; dirs?: boolean[] } {
  const idx = matches.map((m, i) => ({ m, d: dirs?.[i] ?? false }));
  idx.sort((a, b) => (a.m < b.m ? -1 : a.m > b.m ? 1 : 0));
  const out: { m: string; d: boolean }[] = [];
  for (const x of idx) if (out.length === 0 || (out[out.length - 1] as { m: string }).m !== x.m) out.push(x);
  return dirs ? { matches: out.map((x) => x.m), dirs: out.map((x) => x.d) } : { matches: out.map((x) => x.m) };
}

/** __kubectl_format_comp_descriptions */
function formatDescriptions(reply: string[], longest: number, columns: number): string[] {
  return reply.map((c) => {
    const tab = c.indexOf('\t');
    if (tab < 0) return c;
    let desc = c.slice(tab + 1);
    let comp = c.slice(0, tab);
    let max = columns - longest - 4;
    if (max > 8) comp += ' '.repeat(Math.max(0, longest - chars(comp)));
    else max = columns - chars(comp) - 4;
    if (max > 0) {
      if (chars(desc) > max) desc = `${[...desc].slice(0, max - 1).join('')}…`;
      comp += `  (${desc})`;
    }
    return comp;
  });
}

/** __kubectl_handle_standard_completion_case */
function standardCase(completions: string[], cur: string, columns: number): string[] {
  if (completions.length === 0) return [];
  if (!completions.some((c) => c.includes('\t'))) {
    const words = completions.map(shellQuote).map(unquote);
    const reply = words.filter((w) => w.startsWith(cur));
    return reply.length === 1 ? [shellQuote(reply[0] as string)] : reply;
  }
  const reply: string[] = [];
  let longest = 0;
  for (const line of completions) {
    if (line === '') continue;
    const name = line.split('\t')[0] as string;
    if (!shellQuote(name).startsWith(cur)) continue;
    reply.push(line);
    longest = Math.max(longest, chars(name));
  }
  if (reply.length === 1) return [shellQuote((reply[0] as string).split('\t')[0] as string)];
  return formatDescriptions(reply, longest, columns);
}

/** __kubectl_handle_special_char */
function stripSpecial(reply: string[], cur: string, ch: ':' | '='): string[] {
  const i = cur.lastIndexOf(ch);
  if (i < 0) return reply;
  const word = cur.slice(0, i + 1);
  return reply.map((r) => (r.startsWith(word) ? r.slice(word.length) : r));
}

export interface BashContext {
  c: ProgramCompletion;
  fs: Fs;
  home: string | undefined;
  run: RunComplete;
}

/** What one Tab gives through the script; undefined is bash's `-o default` file name completion. */
export function bashComplete({ c, fs, home, run }: BashContext): CompletionResult | undefined {
  const line = (c.line ?? c.words.join(' ')).slice(0, c.point ?? undefined);
  const { words, open } = compWords(line);
  let cur = words[words.length - 1] as string;
  // The function's eval expands an alias in the first word.
  const first = words[0] as string;
  const alias = c.aliases?.[first];
  const head = alias === undefined ? [first] : alias.trim().split(/[ \t]+/);
  // `${args[*]}` is joined with spaces and evaluated again: an unclosed quote fails the eval.
  if (open) return undefined;
  const args = [...head.slice(1), ...words.slice(1).filter((w, i, a) => !(i === a.length - 1 && w === '')).map(evalWord)];
  const lastParam = words[words.length - 1] as string;
  if (cur === '' && !lastParam.endsWith('=')) args.push('');
  if (/^-.*=/.test(cur)) cur = cur.slice(cur.indexOf('=') + 1);
  let out = run(args);
  // out=$(…) drops trailing newlines; the directive is after the last colon, the candidates before it.
  out = out.replace(/\n+$/, '');
  let dirText = out.slice(out.lastIndexOf(':') + 1);
  out = out.includes(':') ? out.slice(0, out.lastIndexOf(':')) : out;
  if (dirText === out) dirText = '0';
  const directive = /^\d+$/.test(dirText) ? Number(dirText) : 0;
  const completions = out.split('\n').filter((l) => l !== '');
  if (directive & DIRECTIVE.error) return undefined;
  const nospace = (directive & DIRECTIVE.noSpace) !== 0;
  const noFile = (directive & DIRECTIVE.noFileComp) !== 0;
  const keepOrder = (directive & DIRECTIVE.keepOrder) !== 0;
  let result: CompletionResult | undefined;
  if (directive & DIRECTIVE.filterFileExt) {
    const exts = completions.join(' ').split(/[ \t\n]+/).filter((x) => x !== '');
    result = filedir(fs, home, cur, exts);
  } else if (directive & DIRECTIVE.filterDirs) {
    const sub = completions[0];
    result = sub ? filedir(fs, home, sub.endsWith('/') ? sub + cur : `${sub}/${cur}`, 'dirs') : filedir(fs, home, cur, 'dirs');
  } else {
    let reply = standardCase(completions, cur, c.columns ?? 80);
    reply = stripSpecial(stripSpecial(reply, cur, ':'), cur, '=');
    if (reply.length > 0) result = keepOrder ? { matches: reply } : sortResult(reply);
  }
  if (result === undefined || result.matches.length === 0) {
    // No candidates: `-o default` completes file names unless NoFileComp turned it off.
    return noFile ? { matches: [] } : undefined;
  }
  return nospace ? { ...result, nospace: true } : result;
}
