// true — do nothing, successfully. GNU coreutils 9.4.
//   docs: true --help of coreutils 9.4
//   upstream: coreutils src/true.c main (only a lone --help or --version is an option)
//   reference: coreutils 9.4 true, captured 2026-11-16 (packages/host/transcripts/coreutils/true.t)
// The shell's builtin true runs instead unless the binary is named: `env true`, `/bin/true`.

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';

/** `true --help`; NUL stands for argv[0]. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: \u0000 [ignored command line arguments]\n  or:  \u0000 OPTION\nExit with a status code indicating success.\n\n      --help        display this help and exit\n      --version     output version information and exit\n\nNOTE: your shell may have its own version of true, which usually supersedes\nthe version described here.  Please refer to your shell's documentation\nfor details about the options it supports.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/true>\nor available locally via: info '(coreutils) true invocation'\n";

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  // `true --help x` and `true --he` are ignored arguments like any other.
  if (p.argv.length === 2) {
    if (p.argv[1] === '--help') {
      yield* p.write(1, HELP.split('\u0000').join(p.argv[0] ?? p.name));
      return 0;
    }
    if (p.argv[1] === '--version') return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  }
  return 0;
}

export const trueProgram: ProgramSpec = { name: 'true', main };
