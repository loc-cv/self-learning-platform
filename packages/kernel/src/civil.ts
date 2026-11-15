// Virtual time and civil dates (docs/ARCHITECTURE.md §2.2). The `Date` object is banned in engine
// packages; simulated machines run in UTC, so these pure functions are all the engine needs.
//
// Algorithms: days_from_civil and civil_from_days by Howard Hinnant,
// https://howardhinnant.github.io/date_algorithms.html (proleptic Gregorian calendar).

/** Milliseconds, an integer. */
export type Millis = number;

export const SECOND: Millis = 1000;
export const MINUTE: Millis = 60 * SECOND;
export const HOUR: Millis = 60 * MINUTE;
export const DAY: Millis = 24 * HOUR;

export interface Civil {
  year: number;
  /** 1–12 */
  month: number;
  /** 1–31 */
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

export function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z: number): { year: number; month: number; day: number } {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

export function millisFromCivil(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): Millis {
  return daysFromCivil(year, month, day) * DAY + hour * HOUR + minute * MINUTE + second * SECOND + ms;
}

export function civilFromMillis(t: Millis): Civil {
  const days = Math.floor(t / DAY);
  let rest = t - days * DAY;
  const hour = Math.floor(rest / HOUR);
  rest -= hour * HOUR;
  const minute = Math.floor(rest / MINUTE);
  rest -= minute * MINUTE;
  const second = Math.floor(rest / SECOND);
  // 1970-01-01 was a Thursday (4).
  const weekday = (((days + 4) % 7) + 7) % 7;
  return { ...civilFromDays(days), hour, minute, second, ms: rest - second * SECOND, weekday };
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** RFC 3339 in UTC with second precision, the form Kubernetes timestamps use: `2026-11-13T09:00:00Z`. */
export function formatRfc3339(t: Millis): string {
  const c = civilFromMillis(t);
  return `${pad(c.year, 4)}-${pad(c.month)}-${pad(c.day)}T${pad(c.hour)}:${pad(c.minute)}:${pad(c.second)}Z`;
}

/**
 * Where the clock starts when a session names no start time (docs/decisions.md D-013): the
 * example date of docs/SCENARIO_FORMAT.md §2, 2026-11-13T09:00:00Z.
 */
export const DEFAULT_START_TIME: Millis = millisFromCivil(2026, 11, 13, 9, 0, 0);
