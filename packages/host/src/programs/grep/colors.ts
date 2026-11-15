// grep's colors: SGR sequences around matches, file names, line numbers and separators.
//   upstream: grep 3.11 src/grep.c (color_dict, parse_grep_colors, sgr_start "\33[%sm\33[K",
//             sgr_end "\33[m\33[K", the GREP_COLOR deprecation warning, should_colorize)
//   reference: grep 3.11 --color=always output, captured 2026-11-16 (packages/host/transcripts/grep/color.t)

export interface Colors {
  /** Matched text in selected lines and in context lines. */
  ms: string;
  mc: string;
  /** Whole selected and context lines. */
  sl: string;
  cx: string;
  fn: string;
  ln: string;
  bn: string;
  se: string;
  /** rv: swap sl and cx with -v. */
  rv: boolean;
  /** ne: no "erase in line" after each sequence. */
  ne: boolean;
}

export function defaultColors(): Colors {
  return { ms: '01;31', mc: '01;31', sl: '', cx: '', fn: '35', ln: '32', bn: '32', se: '36', rv: false, ne: false };
}

const VALUE_CAPS = new Set(['mt', 'ms', 'mc', 'sl', 'cx', 'fn', 'ln', 'bn', 'se']);

/** upstream: grep.c parse_grep_colors — stops quietly at the first malformed entry. */
function parseGrepColors(spec: string, c: Colors, legacy: { ms: boolean; mc: boolean }): void {
  for (const entry of spec.split(':')) {
    const eq = entry.indexOf('=');
    const name = eq < 0 ? entry : entry.slice(0, eq);
    const val = eq < 0 ? undefined : entry.slice(eq + 1);
    if (eq === 0 || (val !== undefined && !/^[0-9;]*$/.test(val))) return;
    if (VALUE_CAPS.has(name) && val !== undefined) {
      if (name === 'mt') {
        c.ms = c.mc = val;
        legacy.ms = legacy.mc = false;
      } else c[name as 'ms'] = val;
      if (name === 'ms' || name === 'mc') legacy[name] = false;
    } else if (name === 'mt') {
      c.mc = c.ms;
      legacy.mc = legacy.ms;
    }
    else if (name === 'rv') c.rv = true;
    else if (name === 'ne') c.ne = true;
  }
}

/** Colors from GREP_COLOR (deprecated) and GREP_COLORS, and the warning grep prints for GREP_COLOR. */
export function colorsFromEnv(env: Readonly<Record<string, string>>): { colors: Colors; warning?: string } {
  const c = defaultColors();
  const legacy = env['GREP_COLOR'];
  // Which colors still come from GREP_COLOR (grep compares the pointers).
  const fromLegacy = { ms: false, mc: false };
  if (legacy !== undefined && legacy !== '' && /^[0-9;]+$/.test(legacy)) {
    c.ms = c.mc = legacy;
    fromLegacy.ms = fromLegacy.mc = true;
  }
  const spec = env['GREP_COLORS'];
  if (spec !== undefined && spec !== '') parseGrepColors(spec, c, fromLegacy);
  if (fromLegacy.ms || fromLegacy.mc) {
    return { colors: c, warning: `warning: GREP_COLOR='${legacy}' is deprecated; use GREP_COLORS='mt=${legacy}'` };
  }
  return { colors: c };
}

export function sgrStart(c: Colors, s: string): string {
  return s === '' ? '' : c.ne ? `\x1b[${s}m` : `\x1b[${s}m\x1b[K`;
}

export function sgrEnd(c: Colors, s: string): string {
  return s === '' ? '' : c.ne ? '\x1b[m' : '\x1b[m\x1b[K';
}
