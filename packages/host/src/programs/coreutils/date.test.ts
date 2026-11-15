// date against the virtual clock, which a golden transcript cannot show (the capture runs at the
// workstation's real time). The layouts are the ones coreutils 9.4 printed, captured 2026-11-16
// (packages/host/transcripts/coreutils/date.t): `Mon Nov 16 08:00:05 UTC 2026` for the default
// format, `-d ''` is midnight today, relative items keep the time of day.

import { millisFromCivil, SECOND } from '@simlab/kernel';
import { describe, expect, test } from 'vitest';
import { defaultTranscriptWorld } from '../../transcript/runner.ts';
import { captureOutput, openSession } from '../../transcript/session.ts';
import { posixtime } from './date.ts';
import { parseDate } from './date-parse.ts';

function session(user = 'student') {
  const capture = captureOutput();
  const w = defaultTranscriptWorld(capture.ports);
  return openSession(w.kernel, capture, { machine: w.machine, user });
}

describe('date in virtual time', () => {
  // The default world starts at 2026-11-13T09:00:00Z, a Friday.
  test('the default format shows the kernel clock', () => {
    const s = session();
    expect(s.run('date').output).toBe('Fri Nov 13 09:00:00 UTC 2026\n');
    expect(s.run('date -u +%FT%T%:z').output).toBe('2026-11-13T09:00:00+00:00\n');
  });

  test('the clock moves with virtual time', () => {
    const s = session();
    s.run('sleep 90');
    expect(s.run('date +%T').output).toBe('09:01:30\n');
    s.kernel.advance(3600 * SECOND);
    expect(s.run('date "+%F %H:%M"').output).toBe('2026-11-13 10:01\n');
  });

  test('strings relative to now', () => {
    const s = session();
    expect(s.run("date -d '' '+%F %T'").output).toBe('2026-11-13 00:00:00\n');
    expect(s.run("date -d now '+%F %T'").output).toBe('2026-11-13 09:00:00\n');
    expect(s.run("date -d today '+%F %T'").output).toBe('2026-11-13 09:00:00\n');
    expect(s.run("date -d tomorrow '+%F %T'").output).toBe('2026-11-14 09:00:00\n');
    expect(s.run("date -d yesterday '+%F %T'").output).toBe('2026-11-12 09:00:00\n');
    expect(s.run("date -d '2 days ago' '+%F %T'").output).toBe('2026-11-11 09:00:00\n');
    expect(s.run("date -d '1 hour' '+%F %T'").output).toBe('2026-11-13 10:00:00\n');
    expect(s.run("date -d '-1 day' +%F").output).toBe('2026-11-12\n');
    expect(s.run("date -d 05:06 '+%F %T'").output).toBe('2026-11-13 05:06:00\n');
    expect(s.run("date -d 'Mar 4' '+%F'").output).toBe('2026-03-04\n');
  });

  test('setting the clock: EPERM for a user, the notice for root', () => {
    const s = session();
    expect(s.run('date -s @0').output).toBe('date: cannot set date: Operation not permitted\nThu Jan  1 00:00:00 UTC 1970\n');
    expect(s.run('date 11140000').output).toBe('date: cannot set date: Operation not permitted\nSat Nov 14 00:00:00 UTC 2026\n');
    const r = session('root').run('date -s @0');
    expect(r.status).toBe(250);
    expect(r.output).toContain('[sim] date: setting the system clock is not simulated yet');
  });
});

describe('date -d parsing', () => {
  const now = millisFromCivil(2026, 11, 13, 9, 0, 0);
  test('forms parse_datetime knows but the simulator does not handle are unsupported, not invalid', () => {
    for (const s of ['next monday', 'x', 'EST', 'first day', 'TZ="UTC" 2026-03-04']) {
      expect(parseDate(s, now), s).toMatchObject({ ok: false, unsupported: expect.any(String) });
    }
  });
  test('words parse_datetime does not know are invalid', () => {
    for (const s of ['foo', '2026-03-04 hrs', '2026-03-04 ago']) expect(parseDate(s, now), s).toEqual({ ok: false, invalid: true });
  });
  test('posixtime operands', () => {
    expect(posixtime('01010000', now)).toBe(millisFromCivil(2026, 1, 1));
    expect(posixtime('0101000027.30', now)).toBe(millisFromCivil(2027, 1, 1, 0, 0, 30));
    expect(posixtime('010100001999', now)).toBe(millisFromCivil(1999, 1, 1));
    for (const s of ['0101', '13010000', '01010000.', '02300000', '0101000027.3']) expect(posixtime(s, now), s).toBeUndefined();
  });
});
