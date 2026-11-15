// Programs of one group, registered through programs/index.ts.

import type { ProgramSpec } from '../proc/program.ts';
import { base64Program } from './coreutils/base64.ts';
import { grepProgram } from './grep/grep.ts';

export const PROGRAMS_GREP: ProgramSpec[] = [grepProgram, base64Program];
