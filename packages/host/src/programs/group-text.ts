// Programs of one group, registered through programs/index.ts.

import type { ProgramSpec } from '../proc/program.ts';

import { catProgram } from './coreutils/cat.ts';
import { cutProgram } from './coreutils/cut.ts';
import { headProgram } from './coreutils/head.ts';
import { tailProgram } from './coreutils/tail.ts';
import { sortProgram } from './coreutils/sort.ts';
import { teeProgram } from './coreutils/tee.ts';
import { trProgram } from './coreutils/tr.ts';
import { uniqProgram } from './coreutils/uniq.ts';
import { wcProgram } from './coreutils/wc.ts';

export const PROGRAMS_TEXT: ProgramSpec[] = [catProgram, headProgram, tailProgram, wcProgram, sortProgram, uniqProgram, cutProgram, trProgram, teeProgram];
