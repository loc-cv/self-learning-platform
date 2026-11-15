// basename — strip directory and suffix from filenames. GNU coreutils 9.4.
//   docs: basename --help and basename(1) of coreutils 9.4
//   upstream: coreutils src/basename.c perform_basename, remove_suffix; gnulib base_name
//   reference: coreutils 9.4 basename, captured 2026-11-16 (packages/host/transcripts/coreutils/basename.t)
// Pure string operations: the names need not exist.

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { parseArgs, usageError } from '../lib/io.ts';
import { quote } from '../lib/quote.ts';
import type { OptionSpec } from '../lib/getopt.ts';

/** `basename --help`; NUL stands for argv[0]. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: \u0000 NAME [SUFFIX]\n  or:  \u0000 OPTION... NAME...\nPrint NAME with any leading directory components removed.\nIf specified, also remove a trailing SUFFIX.\n\nMandatory arguments to long options are mandatory for short options too.\n  -a, --multiple       support multiple arguments and treat each as a NAME\n  -s, --suffix=SUFFIX  remove a trailing SUFFIX; implies -a\n  -z, --zero           end each output line with NUL, not newline\n      --help        display this help and exit\n      --version     output version information and exit\n\nExamples:\n  \u0000 /usr/bin/sort          -> \"sort\"\n  \u0000 include/stdio.h .h     -> \"stdio\"\n  \u0000 -s .h include/stdio.h  -> \"stdio\"\n  \u0000 -a any/str1 any/str2   -> \"str1\" followed by \"str2\"\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/basename>\nor available locally via: info '(coreutils) basename invocation'\n";

const OPTIONS: OptionSpec[] = [
  { short: 'a', long: 'multiple' },
  { short: 's', long: 'suffix', arg: 'required' },
  { short: 'z', long: 'zero' },
  { long: 'help' },
  { long: 'version' },
];

/** The last component without trailing slashes; `/` for a name of slashes only (no // root on Linux). */
export function baseName(name: string): string {
  const trimmed = name.replace(/\/+$/, '');
  if (trimmed === '') return name === '' ? '' : '/';
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** Removes `suffix` when the name ends with it and is longer than it. */
function removeSuffix(name: string, suffix: string): string {
  return name.length > suffix.length && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  if (args.has('help')) {
    yield* p.write(1, HELP.split('\u0000').join(p.argv[0] ?? p.name));
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  const names = args.operands;
  if (names.length === 0) return yield* usageError(p, 'missing operand');
  let suffix = args.value('suffix');
  const multiple = args.has('multiple') || suffix !== undefined;
  const end = args.has('zero') ? '\0' : '\n';
  if (!multiple) {
    if (names.length > 2) return yield* usageError(p, `extra operand ${quote(names[2] as string)}`);
    suffix = names[1];
  }
  let out = '';
  for (const name of multiple ? names : names.slice(0, 1)) {
    const base = baseName(name);
    // The root directory keeps its name whatever the suffix.
    out += (suffix !== undefined && base !== '/' ? removeSuffix(base, suffix) : base) + end;
  }
  yield* p.write(1, out);
  return 0;
}

export const basenameProgram: ProgramSpec = { name: 'basename', main };
