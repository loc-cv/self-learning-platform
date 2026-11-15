// The builtins the simulated bash implements. Every other bash builtin prints a `[sim]` notice
// (BASH_BUILTINS in shell.ts); docs/COVERAGE.md lists both.

import type { Builtin } from '../shell.ts';
import { CORE_BUILTINS } from './core.ts';
import { printf } from './printf.ts';
import { test } from './test.ts';

export const BUILTINS: Record<string, Builtin> = { ...CORE_BUILTINS, printf, test, '[': test };
