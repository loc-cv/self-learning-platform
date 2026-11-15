// `touch -d` and `touch -t` against the real touch: each value is what `stat -c %.3Y` printed
// after `touch -d STRING f` (or `-t STAMP`). reference: coreutils 9.4 touch, TZ=UTC, captured 2026-11-16
import { describe, expect, test } from 'vitest';
import { millisFromCivil } from '@simlab/kernel';
import { parseTouchDate, parseTouchStamp } from './touchdate.ts';

const DATES: [string, number][] = [
  ['2026-11-10 08:30', 1794299400000],
  ['2026-11-10 08:30:15', 1794299415000],
  ['2026-11-10', 1794268800000],
  ['@1700000000', 1700000000000],
  ['@-1', -1000],
  ['@1.999', 1999],
  ['2026-11-10T08:30:00', 1794299400000],
  ['2026-11-10T08:30:00Z', 1794299400000],
  ['2026-11-10 08:30 +0200', 1794292200000],
  ['2026-11-10T08:30:00+02:00', 1794292200000],
  ['2026-11-10 08:30:00+0530', 1794279600000],
  ['2026-11-10 08:30:00 +02', 1794292200000],
  ['26-11-10', 1794268800000],
  ['69-11-10', -4492800000],
  ['68-11-10', 3119731200000],
  ['2026-1-5 8:3', 1767600180000],
  ['2026-11-10 0830', 1794299400000],
  ['  2026-11-10   08:30 ', 1794299400000],
  ['2026-11-10t08:30', 1794299400000],
  ['2026-11-10 08:30 UTC', 1794299400000],
  ['2026-11-10 08:30:00 GMT', 1794299400000],
  ['2026-11-10T08:30:00.123Z', 1794299400123],
  ['2024-02-29 12:00', 1709208000000],
];

const STAMPS: [string, number][] = [
  ['202611100830', 1794299400000],
  ['202611100830.45', 1794299445000],
  ['11100830', 1794299400000],
  ['2611100830', 1794299400000],
  ['6911100830', -4462200000],
  ['6811100830', 3119761800000],
  ['202611100830.60', 1794299460000],
  ['192611100830', -1361460600000],
];

// Rejected with "invalid date format" by the real touch, same capture.
const INVALID_DATES = ['2026-13-10', '2026-11-10 25:00', '2026-11-10 24:00', '2026-11-10 23:59:60', '2026-11-10 23:60', '2026-02-30', '2026-00-10', '-2026-11-10', '+2026-11-10', '@5x'];
const INVALID_STAMPS = ['1110083', '202613100830', '202611100830.61', '202602290000', '2026111008', '20261110083', '202611100830.5', '0001111008300'];

describe('touch dates', () => {
  test.each(DATES)('-d %j', (s, ms) => expect(parseTouchDate(s)).toEqual({ ok: true, ms }));
  test.each(STAMPS)('-t %s', (s, ms) => expect(parseTouchStamp(s, millisFromCivil(2026, 11, 13, 9))).toBe(ms));
  test.each(INVALID_DATES)('-d %j is invalid', (s) => expect(parseTouchDate(s)).toEqual({ ok: false, invalid: true }));
  test.each(INVALID_STAMPS)('-t %s is invalid', (s) => expect(parseTouchStamp(s, 0)).toBeNull());
  test.each(['yesterday', 'Nov 10 2026', '', '2026-11-10 08', 'next friday'])('-d %j is not simulated', (s) =>
    expect(parseTouchDate(s)).toEqual({ ok: false, unsupported: true }),
  );
});
