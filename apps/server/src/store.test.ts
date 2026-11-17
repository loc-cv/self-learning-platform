import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { appendLines, readLines, writeJsonAtomic } from './store.ts';

const dir = (): string => mkdtempSync(join(tmpdir(), 'simlab-store-'));

/** Writes bytes with no newline at the end, as a writer killed inside `write` leaves them. */
function cut(file: string, fragment: string): void {
  const fd = openSync(file, 'a');
  writeSync(fd, fragment);
  closeSync(fd);
}

describe('the file store', () => {
  test('appends whole lines, creating the directory, and reads them back', () => {
    const file = join(dir(), 'nested', 'log.jsonl');
    expect(readLines(file)).toEqual([]);
    appendLines(file, ['{"a":1}', '{"a":2}']);
    appendLines(file, []);
    appendLines(file, ['{"a":3}']);
    expect(readLines(file)).toEqual(['{"a":1}', '{"a":2}', '{"a":3}']);
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n{"a":2}\n{"a":3}\n');
    expect(() => appendLines(file, ['two\nlines'])).toThrow('newline');
  });

  test('a write cut in the middle of a line is ignored by readers and removed by the next append', () => {
    const file = join(dir(), 'log.jsonl');
    appendLines(file, ['{"seq":0}', '{"seq":1}']);
    cut(file, '{"seq":2,"pad":"xxxx');
    expect(readLines(file)).toEqual(['{"seq":0}', '{"seq":1}']);
    appendLines(file, ['{"seq":2}']);
    expect(readFileSync(file, 'utf8')).toBe('{"seq":0}\n{"seq":1}\n{"seq":2}\n');
    for (const l of readLines(file)) expect(() => JSON.parse(l) as unknown).not.toThrow();
  });

  test('a fragment longer than the tail buffer, and a file that is only a fragment', () => {
    const file = join(dir(), 'log.jsonl');
    appendLines(file, ['first']);
    cut(file, 'y'.repeat(200_000));
    expect(readLines(file)).toEqual(['first']);
    appendLines(file, ['second']);
    expect(readFileSync(file, 'utf8')).toBe('first\nsecond\n');

    const only = join(dir(), 'only.jsonl');
    writeFileSync(only, '{"torn":');
    expect(readLines(only)).toEqual([]);
    appendLines(only, ['{"ok":true}']);
    expect(readFileSync(only, 'utf8')).toBe('{"ok":true}\n');
  });

  test('replaces a JSON file through a temporary file that does not stay behind', () => {
    const d = dir();
    const file = join(d, 'settings.json');
    writeJsonAtomic(file, { lang: 'en' });
    writeJsonAtomic(file, { lang: 'vi', retention: 0.9 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ lang: 'vi', retention: 0.9 });
    expect(readdirSync(d)).toEqual(['settings.json']);
  });
});
