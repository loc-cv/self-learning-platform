// lint-as: packages/host/src/vfs/real.ts
// expect: simlab/engine-determinism x5
import { readFileSync } from 'node:fs';
import * as os from 'os';
export const text = readFileSync('/etc/hostname', 'utf8');
export const home = process.env['HOME'];
export const host = os.hostname();
export const buf = Buffer.from('x');
console.log(text);
