// Programs of one group, registered through programs/index.ts.

import type { ProgramSpec } from '../proc/program.ts';
import { dirProgram, lsProgram, vdirProgram } from './coreutils/ls.ts';

export const PROGRAMS_LS: ProgramSpec[] = [lsProgram, dirProgram, vdirProgram];
