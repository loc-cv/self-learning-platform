// lint-as: packages/kernel/src/clock.test.ts
// expect: none
import { readFileSync } from 'node:fs';
export const fixture = readFileSync('fixture.txt', 'utf8');
