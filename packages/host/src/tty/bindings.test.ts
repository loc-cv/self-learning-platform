// bindings.ts must say what `bind -p` of the real bash says (fixtures/reference/bash/bind-p.txt).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { BINDINGS } from './bindings.ts';

/** readline's key notation (`\C-a`, `\e[A`, `\C-?`, `\\`, `\"`) to the bytes. */
function keyBytes(k: string): string {
  let out = '';
  for (let i = 0; i < k.length; ) {
    if (k.startsWith('\\C-', i)) {
      let c = k[i + 3] as string;
      let n = 4;
      if (c === '\\') {
        c = k[i + 4] as string;
        n = 5;
      }
      out += c === '?' ? '\x7f' : String.fromCharCode((/[a-z]/i.test(c) ? c.toLowerCase() : c).charCodeAt(0) & 0x1f);
      i += n;
    } else if (k.startsWith('\\e', i)) {
      out += '\x1b';
      i += 2;
    } else if (k[i] === '\\' && (k[i + 1] === '\\' || k[i + 1] === '"')) {
      out += k[i + 1];
      i += 2;
    } else out += k[i++];
  }
  return out;
}

test('every binding bash reports, other than self-insert, is in the table with the same command', () => {
  const text = readFileSync(join(import.meta.dirname, '../../../../fixtures/reference/bash/bind-p.txt'), 'utf8');
  const want: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^"(.*)": (\S+)$/.exec(line);
    if (!m || m[2] === 'self-insert' || m[2] === 'do-lowercase-version') continue;
    const key = keyBytes(m[1] as string);
    // bind -p lists bash's synonym insert-last-argument before yank-last-arg for the same keys.
    want[key] ??= m[2] as string;
  }
  expect(BINDINGS).toEqual(want);
});
