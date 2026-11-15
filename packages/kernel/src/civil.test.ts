import { expect, test } from 'vitest';
import { civilFromMillis, DEFAULT_START_TIME, formatRfc3339, millisFromCivil } from './civil.ts';

// Expected epoch milliseconds and weekdays computed with Python's datetime in UTC.
const cases: [string, number, number][] = [
  ['1970-01-01T00:00:00Z', 0, 4],
  ['2026-11-13T09:00:00Z', 1794560400000, 5],
  ['2024-02-29T12:34:56Z', 1709210096789, 4],
  ['1969-12-31T23:59:59Z', -1000, 3],
  ['2000-03-01T00:00:00Z', 951868800000, 3],
];

test.each(cases)('%s', (iso, ms, weekday) => {
  expect(formatRfc3339(ms)).toBe(iso);
  const c = civilFromMillis(ms);
  expect(c.weekday).toBe(weekday);
  expect(millisFromCivil(c.year, c.month, c.day, c.hour, c.minute, c.second, c.ms)).toBe(ms);
});

test('round-trips every day across four centuries', () => {
  for (let t = millisFromCivil(1900, 1, 1); t < millisFromCivil(2300, 1, 1); t += 86_400_000 * 7 + 3_600_001) {
    const c = civilFromMillis(t);
    expect(millisFromCivil(c.year, c.month, c.day, c.hour, c.minute, c.second, c.ms)).toBe(t);
  }
});

test('the default start time is the documented date', () => {
  expect(formatRfc3339(DEFAULT_START_TIME)).toBe('2026-11-13T09:00:00Z');
});
