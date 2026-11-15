// Programs of one group, registered through programs/index.ts: small coreutils (sleep, date, env,
// seq, basename, dirname, whoami, id, and the binaries behind the shell builtins echo, printf,
// true, false, pwd, test and [), debianutils which, ncurses clear and hostname.

import type { ProgramSpec } from '../proc/program.ts';
import { basenameProgram } from './coreutils/basename.ts';
import { dirnameProgram } from './coreutils/dirname.ts';
import { idProgram } from './coreutils/id.ts';
import { whoamiProgram } from './coreutils/whoami.ts';
import { whichProgram } from './debianutils/which.ts';
import { clearProgram } from './ncurses/clear.ts';
import { hostnameProgram } from './hostname/hostname.ts';
import { seqProgram } from './coreutils/seq.ts';
import { printfProgram } from './coreutils/printf.ts';
import { bracketProgram, testProgram } from './coreutils/test.ts';
import { dateProgram } from './coreutils/date.ts';
import { envProgram } from './coreutils/env.ts';
import { echoProgram } from './coreutils/echo.ts';
import { falseProgram } from './coreutils/false.ts';
import { pwdProgram } from './coreutils/pwd.ts';
import { sleepProgram } from './coreutils/sleep.ts';
import { trueProgram } from './coreutils/true.ts';

export const PROGRAMS_MISC: ProgramSpec[] = [sleepProgram, echoProgram, trueProgram, falseProgram, pwdProgram, envProgram, basenameProgram, dirnameProgram, whoamiProgram, idProgram, whichProgram, clearProgram, hostnameProgram, seqProgram, printfProgram, testProgram, bracketProgram, dateProgram];
