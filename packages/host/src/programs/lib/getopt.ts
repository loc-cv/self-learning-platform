// Command-line parsing as glibc's getopt_long does it, which every GNU program uses: short option
// clusters, attached or separate arguments, long options with `=value` or a separate value,
// unambiguous abbreviations of long options, `--`, and argument permutation (options may follow
// operands unless POSIXLY_CORRECT is set).
//   docs: getopt(3) (man-pages 6.7 on the workstation)
//   reference: glibc 2.39 diagnostics as GNU coreutils 9.4 prints them, captured 2026-11-16
//              (packages/host/transcripts/coreutils/cat.t, ls-errors.t, grep/basic.t)
//
// A program declares every option the real program has. Options the simulator does not support
// are declared with `supported: false`: using one prints the `[sim]` notice, never an error the
// real program would not print and never a silent no-op (docs/FIDELITY.md §4.1).

export interface OptionSpec {
  /** Identifier the program switches on; defaults to the long name or the short letter. */
  id?: string;
  short?: string;
  long?: string;
  arg?: 'none' | 'required' | 'optional';
  /** False when the real option exists but is not simulated yet. Default true. */
  supported?: boolean;
}

export interface ParsedOption {
  id: string;
  value?: string;
  /** As written, for notices: `-Z`, `--context`. */
  name: string;
}

export type GetoptResult =
  | { ok: true; options: ParsedOption[]; operands: string[] }
  /** A usage error, with glibc's message (no program prefix). */
  | { ok: false; error: string }
  /** A real option that is not simulated. */
  | { ok: false; unsupported: string };

export interface GetoptConfig {
  options: readonly OptionSpec[];
  /** Stop at the first operand (POSIXLY_CORRECT, or programs like `env` that take a command). */
  stopAtOperand?: boolean;
}

const idOf = (o: OptionSpec): string => o.id ?? o.long ?? (o.short as string);

export function getopt(argv: readonly string[], cfg: GetoptConfig): GetoptResult {
  const options: ParsedOption[] = [];
  const operands: string[] = [];
  const shorts = new Map<string, OptionSpec>();
  for (const o of cfg.options) if (o.short) shorts.set(o.short, o);
  const longs = cfg.options.filter((o) => o.long !== undefined);

  const take = (o: OptionSpec, name: string, value?: string): GetoptResult | undefined => {
    if (o.supported === false) return { ok: false, unsupported: name };
    options.push(value === undefined ? { id: idOf(o), name } : { id: idOf(o), name, value });
    return undefined;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') {
      operands.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const value = eq < 0 ? undefined : a.slice(eq + 1);
      let match = longs.find((o) => o.long === name);
      if (!match) {
        const cands = longs.filter((o) => (o.long as string).startsWith(name));
        // Abbreviations that all name the same option are not ambiguous.
        const distinct = cands.filter((o, k) => cands.findIndex((c) => idOf(c) === idOf(o) && c.arg === o.arg) === k);
        if (distinct.length === 0) return { ok: false, error: `unrecognized option '${a}'` };
        if (distinct.length > 1) {
          // glibc lists the first candidate and each later one that differs from it, so an alias
          // of the first (grep's --fixed-strings after --fixed-regexp) is left out.
          const first = cands[0] as OptionSpec;
          const listed = cands.filter((c, k) => k === 0 || idOf(c) !== idOf(first) || c.arg !== first.arg);
          return { ok: false, error: `option '--${name}' is ambiguous; possibilities:${listed.map((c) => ` '--${c.long}'`).join('')}` };
        }
        match = distinct[0] as OptionSpec;
      }
      const full = `--${match.long}`;
      const kind = match.arg ?? 'none';
      if (kind === 'none' && value !== undefined) return { ok: false, error: `option '${full}' doesn't allow an argument` };
      if (kind === 'required' && value === undefined) {
        if (i + 1 >= argv.length) return { ok: false, error: `option '${full}' requires an argument` };
        const r = take(match, full, argv[++i] as string);
        if (r) return r;
        continue;
      }
      const r = take(match, full, value);
      if (r) return r;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k] as string;
        const o = shorts.get(ch);
        if (!o) return { ok: false, error: `invalid option -- '${ch}'` };
        const kind = o.arg ?? 'none';
        if (kind === 'none') {
          const r = take(o, `-${ch}`);
          if (r) return r;
          continue;
        }
        const rest = a.slice(k + 1);
        if (rest !== '') {
          const r = take(o, `-${ch}`, rest);
          if (r) return r;
        } else if (kind === 'required') {
          if (i + 1 >= argv.length) return { ok: false, error: `option requires an argument -- '${ch}'` };
          const r = take(o, `-${ch}`, argv[++i] as string);
          if (r) return r;
        } else {
          const r = take(o, `-${ch}`);
          if (r) return r;
        }
        break;
      }
      continue;
    }
    operands.push(a);
    if (cfg.stopAtOperand) {
      operands.push(...argv.slice(i + 1));
      break;
    }
  }
  return { ok: true, options, operands };
}
