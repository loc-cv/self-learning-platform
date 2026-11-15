// Programs of one group, registered through programs/index.ts.

import type { ProgramSpec } from '../proc/program.ts';
import { chmodProgram } from './coreutils/chmod.ts';
import { chownProgram } from './coreutils/chown.ts';
import { cpProgram } from './coreutils/cp.ts';
import { lnProgram } from './coreutils/ln.ts';
import { mkdirProgram } from './coreutils/mkdir.ts';
import { mvProgram } from './coreutils/mv.ts';
import { rmProgram } from './coreutils/rm.ts';
import { rmdirProgram } from './coreutils/rmdir.ts';
import { touchProgram } from './coreutils/touch.ts';

export const PROGRAMS_FILES: ProgramSpec[] = [mkdirProgram, touchProgram, rmProgram, rmdirProgram, chmodProgram, chownProgram, lnProgram, cpProgram, mvProgram];
