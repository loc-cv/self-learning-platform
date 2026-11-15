// Programs the host registers. Executable stubs in a machine's /usr/bin name them; a stub whose
// program is not registered prints the "not simulated yet" notice.

import type { ProgramSpec } from '../proc/program.ts';
import { bashProgram } from '../shell/bash.ts';
import { PROGRAMS_EDITORS } from './editors/editors.ts';
import { PROGRAMS_FILES } from './group-files.ts';
import { PROGRAMS_GREP } from './group-grep.ts';
import { PROGRAMS_LS } from './group-ls.ts';
import { PROGRAMS_MISC } from './group-misc.ts';
import { PROGRAMS_TEXT } from './group-text.ts';

export const PROGRAMS: ProgramSpec[] = [bashProgram, ...PROGRAMS_FILES, ...PROGRAMS_LS, ...PROGRAMS_TEXT, ...PROGRAMS_GREP, ...PROGRAMS_MISC, ...PROGRAMS_EDITORS];
