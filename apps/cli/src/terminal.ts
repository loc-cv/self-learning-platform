// What the terminal front ends (play.ts, lab.ts) share: their own messages, and the real editor
// that answers the simulated vim and nano.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { EditorRequest } from '@simlab/host';

export const say = (msg: string): void => {
  process.stderr.write(`\x1b[2m[simlab] ${msg}\x1b[0m\r\n`);
};

/** Opens the user's editor on a temporary copy of the file and returns what it holds afterwards. */
export function editInRealEditor(req: EditorRequest): string {
  const dir = mkdtempSync(join(tmpdir(), 'simlab-edit-'));
  const file = join(dir, basename(req.path) || 'file');
  try {
    writeFileSync(file, req.content);
    const before = statSync(file).mtimeMs;
    const editor = process.env['VISUAL'] || process.env['EDITOR'] || 'vi';
    if (req.readOnly) say(`${req.name} is read-only for this user in the simulated machine; a save will fail there`);
    process.stdin.setRawMode(false);
    // Through sh, so that EDITOR may carry arguments ("code --wait").
    const r = spawnSync('/bin/sh', ['-c', `${editor} "$1"`, 'sh', file], { stdio: 'inherit' });
    process.stdin.setRawMode(true);
    if (r.error) say(`could not run ${editor}: ${r.error.message}`);
    const after = readFileSync(file, 'utf8');
    return statSync(file).mtimeMs === before && after === req.content ? req.content : after;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
