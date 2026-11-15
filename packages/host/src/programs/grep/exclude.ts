// --include, --exclude, --exclude-from and --exclude-dir: which files and directories grep skips.
//   upstream: grep 3.11 src/grep.c skipped_file, exclude_options; gnulib lib/exclude.c
//             (excluded_file_name, exclude_fnmatch, fnmatch_pattern_has_wildcards)
// A name met while recursing is matched whole against its base name (EXCLUDE_ANCHORED); a
// command-line operand matches when the whole name or any part after a `/` matches. Wildcards
// are fnmatch(3) without flags: `*` and `?` also match `/` and a leading `.`.

import { globMatch, type PatChar } from '../../shell/glob.ts';

export interface ExcludeRule {
  pattern: string;
  /** --include: a file that matches no rule is skipped when the first rule given is an --include. */
  include: boolean;
}

/** upstream: gnulib exclude.c fnmatch_pattern_has_wildcards (backslash escapes, no extglob) */
function hasWildcards(p: string): boolean {
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') i++;
    else if (c === '?' || c === '*' || c === '[' || c === ']') return true;
  }
  return false;
}

function toPattern(p: string): PatChar[] {
  const out: PatChar[] = [];
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '\\' && i + 1 < p.length) out.push({ c: p[++i] as string, quoted: true });
    else out.push({ c: p[i] as string, quoted: false });
  }
  return out;
}

function matchOne(pattern: string, name: string): boolean {
  return hasWildcards(pattern) ? globMatch(toPattern(pattern), name) : pattern === name;
}

/** upstream: gnulib exclude.c exclude_fnmatch */
function matches(pattern: string, name: string, anchored: boolean): boolean {
  if (matchOne(pattern, name)) return true;
  if (anchored) return false;
  for (let i = 0; i < name.length; i++) if (name[i] === '/' && name[i + 1] !== '/' && matchOne(pattern, name.slice(i + 1))) return true;
  return false;
}

/**
 * upstream: gnulib exclude.c excluded_file_name — the last rule that matches decides; when none
 * does, the name is excluded exactly when the first rule is an --include.
 */
export function excluded(rules: readonly ExcludeRule[], name: string, anchored: boolean): boolean {
  if (rules.length === 0) return false;
  for (let k = rules.length - 1; k >= 0; k--) {
    const r = rules[k] as ExcludeRule;
    if (matches(r.pattern, name, anchored)) return !r.include;
  }
  return (rules[0] as ExcludeRule).include;
}

/** upstream: gnulib exclude.c add_exclude_fp — one pattern per line, trailing blanks dropped. */
export function excludeFileRules(text: string): ExcludeRule[] {
  return text
    .split('\n')
    .map((l) => l.replace(/[ \t\n\v\f\r]+$/, ''))
    .filter((l) => l !== '')
    .map((pattern) => ({ pattern, include: false }));
}
