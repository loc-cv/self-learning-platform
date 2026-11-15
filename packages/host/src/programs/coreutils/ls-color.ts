// ls colors: the built-in indicator table, LS_COLORS parsing and the choice of color per file.
//   upstream: coreutils src/ls.c color_indicator, parse_ls_color, get_funky_string,
//             get_color_indicator, known_term_type; dircolors' default TERM list
//   reference: coreutils 9.4 `ls --color=always | cat -v` with LS_COLORS unset (di 01;34, ln 01;36,
//              ex 01;32, pi 33, cd 01;33, su 37;41, sg 30;43, st 37;44, ow 34;42, tw 30;42, and the
//              leading reset), error messages for bad LS_COLORS values, `dircolors -p` TERM
//              lines, captured 2026-11-16 (packages/host/transcripts/coreutils/ls-color.t)

import { globMatch, type PatChar } from '../../shell/glob.ts';

/** Indicator names in LS_COLORS order (indicator_name in ls.c). */
export const INDICATORS = [
  'lc', 'rc', 'ec', 'rs', 'no', 'fi', 'di', 'ln', 'pi', 'so', 'bd', 'cd', 'mi', 'or', 'ex', 'do', 'su', 'sg', 'st', 'ow', 'tw', 'ca', 'mh', 'cl',
] as const;
export type Indicator = (typeof INDICATORS)[number];

/** The built-in sequences used when LS_COLORS is unset; null is "not colored". */
const DEFAULTS: Record<Indicator, string | null> = {
  lc: '\x1b[', rc: 'm', ec: null, rs: '0', no: null, fi: null, di: '01;34', ln: '01;36', pi: '33', so: '01;35', bd: '01;33', cd: '01;33',
  mi: null, or: null, ex: '01;32', do: '01;35', su: '37;41', sg: '30;43', st: '37;44', ow: '34;42', tw: '30;42', ca: null, mh: null, cl: '\x1b[K',
};

export interface ColorExt {
  ext: string;
  seq: string;
  exact: boolean;
  /** Shadowed by an earlier entry. */
  dead: boolean;
}

export interface Colors {
  ind: Record<Indicator, string | null>;
  /** Later definitions first, as ls keeps them. */
  exts: ColorExt[];
  /** `ln=target`: color links as the file they point to. */
  linkAsReferent: boolean;
}

/** dircolors' TERM patterns: without LS_COLORS, color is used only for these terminals. */
const TERMS = [
  'Eterm', 'ansi', '*color*', 'con[0-9]*x[0-9]*', 'cons25', 'console', 'cygwin', '*direct*', 'dtterm', 'gnome', 'hurd', 'jfbterm', 'konsole', 'kterm',
  'linux', 'linux-c', 'mlterm', 'putty', 'rxvt*', 'screen*', 'st', 'terminator', 'tmux*', 'vt100', 'xterm*',
];

const pat = (s: string): PatChar[] => [...s].map((c) => ({ c, quoted: false }));

/** get_funky_string: one value with backslash and caret escapes, up to `:` (or `=` for a suffix). */
function funky(src: string, pos: number, equalsEnd: boolean): { value: string; next: number } | undefined {
  let out = '';
  let i = pos;
  type State = 'gnd' | 'backslash' | 'octal' | 'hex' | 'caret';
  let state: State = 'gnd';
  let num = 0;
  for (;;) {
    const c = src[i];
    switch (state) {
      case 'gnd':
        if (c === undefined || c === ':' || (equalsEnd && c === '=')) return { value: out, next: i };
        if (c === '\\') state = 'backslash';
        else if (c === '^') state = 'caret';
        else out += c;
        i++;
        break;
      case 'backslash':
        if (c === undefined) return undefined;
        if (c >= '0' && c <= '7') {
          state = 'octal';
          num = c.charCodeAt(0) - 48;
        } else if (c === 'x' || c === 'X') {
          state = 'hex';
          num = 0;
        } else {
          const named: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '?': '\x7f', _: ' ' };
          out += named[c] ?? c;
          state = 'gnd';
        }
        i++;
        break;
      case 'octal':
        if (c !== undefined && c >= '0' && c <= '7') {
          num = (num << 3) + c.charCodeAt(0) - 48;
          i++;
        } else {
          out += String.fromCharCode(num & 0xff);
          state = 'gnd';
        }
        break;
      case 'hex':
        if (c !== undefined && /[0-9a-fA-F]/.test(c)) {
          num = (num << 4) + parseInt(c, 16);
          i++;
        } else {
          out += String.fromCharCode(num & 0xff);
          state = 'gnd';
        }
        break;
      case 'caret':
        if (c === undefined) return undefined;
        if (c >= '@' && c <= '~') out += String.fromCharCode(c.charCodeAt(0) & 0x1f);
        else if (c === '?') out += '\x7f';
        else return undefined;
        state = 'gnd';
        i++;
        break;
    }
  }
}

export type ColorSetup = { colors: Colors | null; warnings: string[] };

/**
 * parse_ls_color. `colors` is null when color is off: LS_COLORS is unset and the terminal type is
 * not one dircolors knows, or LS_COLORS cannot be parsed (with ls's warnings).
 */
export function setupColors(env: Readonly<Record<string, string>>): ColorSetup {
  const ind = { ...DEFAULTS };
  const spec = env['LS_COLORS'];
  if (spec === undefined || spec === '') {
    const term = env['TERM'];
    const colorterm = env['COLORTERM'];
    const known = term !== undefined && TERMS.some((t) => globMatch(pat(t), term));
    if (!(colorterm !== undefined && colorterm !== '') && !known) return { colors: null, warnings: [] };
    return { colors: { ind, exts: [], linkAsReferent: false }, warnings: [] };
  }
  const exts: ColorExt[] = [];
  const warnings: string[] = [];
  let i = 0;
  let failed = false;
  for (;;) {
    const c = spec[i];
    if (c === undefined) break;
    if (c === ':') {
      i++;
      continue;
    }
    if (c === '*') {
      const e = funky(spec, i + 1, true);
      if (!e || spec[e.next] !== '=') {
        failed = true;
        break;
      }
      const v = funky(spec, e.next + 1, false);
      if (!v) {
        failed = true;
        break;
      }
      exts.unshift({ ext: e.value, seq: v.value, exact: false, dead: false });
      i = v.next;
      continue;
    }
    const l0 = c;
    const l1 = spec[i + 1];
    if (l1 === undefined || spec[i + 2] !== '=') {
      failed = true;
      break;
    }
    const label = (l0 + l1) as Indicator;
    if (!(INDICATORS as readonly string[]).includes(label)) {
      // reference: `ls: unrecognized prefix: ‘zz’`
      warnings.push(`unrecognized prefix: ‘${l0}${l1}’`);
      failed = true;
      break;
    }
    const v = funky(spec, i + 3, false);
    if (!v) {
      failed = true;
      break;
    }
    ind[label] = v.value;
    i = v.next;
  }
  if (failed) {
    warnings.push('unparsable value for LS_COLORS environment variable');
    return { colors: null, warnings };
  }
  // Suffixes match ignoring case unless two of them differ only in case and color.
  const lower = (s: string): string => s.replace(/[A-Z]/g, (x) => x.toLowerCase());
  for (let a = 0; a < exts.length; a++) {
    const e1 = exts[a] as ColorExt;
    let caseIgnored = false;
    for (let b = a + 1; b < exts.length; b++) {
      const e2 = exts[b] as ColorExt;
      if (e2.dead || e1.ext.length !== e2.ext.length) continue;
      if (e1.ext === e2.ext) e2.dead = true;
      else if (lower(e1.ext) === lower(e2.ext)) {
        if (caseIgnored) e2.dead = true;
        else if (e1.seq === e2.seq) {
          e2.dead = true;
          caseIgnored = true;
        } else e1.exact = e2.exact = true;
      }
    }
  }
  return { colors: { ind, exts, linkAsReferent: ind.ln === 'target' }, warnings };
}

/** is_colored: set to something other than nothing, `0` or `00`. */
export function isColored(colors: Colors, i: Indicator): boolean {
  const s = colors.ind[i];
  return !(s === null || s === '' || s === '0' || s === '00');
}

/** What get_color_indicator looks at for one name. */
export interface ColorSubject {
  name: string;
  /** stat (or lstat) succeeded. */
  statOk: boolean;
  /** The file type known without stat (from the directory entry). */
  type: 'file' | 'dir' | 'symlink' | 'char' | 'unknown';
  /** st_mode including the type bits; 0 when unknown. */
  mode: number;
  nlink: number;
  /** For a symlink: whether its target exists; for a target: -1 when it does not. */
  linkok: number;
}

export const S_IFMT = 0o170000;
export const S_IFDIR = 0o040000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;
export const S_IFCHR = 0o020000;

/** get_color_indicator: the sequence for a name, or null for none. */
export function colorFor(colors: Colors, s: ColorSubject): string | null {
  let type: Indicator;
  const fmt = s.mode & S_IFMT;
  if (s.linkok === -1 && isColored(colors, 'mi')) type = 'mi';
  else if (!s.statOk) {
    type = s.type === 'dir' ? 'di' : s.type === 'symlink' ? 'ln' : s.type === 'char' ? 'cd' : s.type === 'file' ? 'fi' : 'or';
  } else if (fmt === S_IFREG) {
    type = 'fi';
    if (s.mode & 0o4000 && isColored(colors, 'su')) type = 'su';
    else if (s.mode & 0o2000 && isColored(colors, 'sg')) type = 'sg';
    else if (s.mode & 0o111 && isColored(colors, 'ex')) type = 'ex';
    else if (s.nlink > 1 && isColored(colors, 'mh')) type = 'mh';
  } else if (fmt === S_IFDIR) {
    type = 'di';
    if (s.mode & 0o1000 && s.mode & 0o002 && isColored(colors, 'tw')) type = 'tw';
    else if (s.mode & 0o002 && isColored(colors, 'ow')) type = 'ow';
    else if (s.mode & 0o1000 && isColored(colors, 'st')) type = 'st';
  } else if (fmt === S_IFLNK) type = 'ln';
  else if (fmt === S_IFCHR) type = 'cd';
  else type = 'or';

  if (type === 'fi') {
    const lowerName = s.name.replace(/[A-Z]/g, (x) => x.toLowerCase());
    for (const e of colors.exts) {
      if (e.dead || e.ext.length > s.name.length) continue;
      const hit = e.exact ? s.name.endsWith(e.ext) : lowerName.endsWith(e.ext.replace(/[A-Z]/g, (x) => x.toLowerCase()));
      if (hit) return e.seq;
    }
  }
  if (type === 'ln' && s.linkok === 0 && (colors.linkAsReferent || isColored(colors, 'or'))) type = 'or';
  return colors.ind[type];
}
