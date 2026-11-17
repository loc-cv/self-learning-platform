// Plain files under the data directory (PLAN.md §11: append-only JSONL, no database). Three
// operations cover everything the server stores: append whole lines, read whole lines, replace a
// JSON file. A process killed in the middle of a write leaves at most a fragment after the last
// newline; readers ignore it and the next append removes it, so a log is always only whole lines.

import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const NEWLINE = 0x0a;
/** How much of the tail is read at a time when looking for the last newline. */
const CHUNK = 64 * 1024;

/**
 * Cuts a fragment after the last newline off the file behind `fd` (a file with no newline at
 * all becomes empty). Returns the number of bytes removed.
 */
function repairTail(fd: number): number {
  const size = fstatSync(fd).size;
  if (size === 0) return 0;
  const buf = Buffer.alloc(Math.min(CHUNK, size));
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - buf.length);
    const n = readSync(fd, buf, 0, end - start, start);
    const at = buf.subarray(0, n).lastIndexOf(NEWLINE);
    if (at >= 0) {
      const keep = start + at + 1;
      if (keep < size) ftruncateSync(fd, keep);
      return size - keep;
    }
    end = start;
  }
  ftruncateSync(fd, 0);
  return size;
}

/**
 * Appends `lines` (without their newlines) to `file`, creating its directory. A torn tail left
 * by a killed writer is removed first. All lines go out in one `write` on an append descriptor
 * and are synced before this returns, so a caller that got an answer has its lines on disk.
 */
export function appendLines(file: string, lines: readonly string[]): void {
  if (lines.length === 0) return;
  for (const l of lines) if (l.includes('\n')) throw new Error('a line cannot contain a newline');
  mkdirSync(dirname(file), { recursive: true });
  // 'a+' so the tail can be read for the repair; writes still always go to the end.
  const fd = openSync(file, 'a+');
  try {
    repairTail(fd);
    const data = Buffer.from(lines.map((l) => `${l}\n`).join(''), 'utf8');
    let done = 0;
    // One write call takes the whole buffer on a regular file; the loop is for the short write
    // the system call is allowed to make.
    while (done < data.length) done += writeSync(fd, data, done, data.length - done);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The file's text up to and including its last newline; '' when the file is absent. */
export function readWhole(file: string): string {
  if (!existsSync(file)) return '';
  const data = readFileSync(file);
  const end = data.lastIndexOf(NEWLINE);
  return end < 0 ? '' : data.subarray(0, end + 1).toString('utf8');
}

/** The complete lines of `file`; a final fragment without a newline is ignored. Missing file: []. */
export function readLines(file: string): string[] {
  const text = readWhole(file);
  return text === '' ? [] : text.slice(0, -1).split('\n');
}

/** Replaces `file` with `value` as JSON: a temporary file beside it, synced, then renamed over it. */
export function writeJsonAtomic(file: string, value: unknown): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.tmp`);
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}
