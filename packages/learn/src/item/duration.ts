// Durations and start times as items write them (docs/SCENARIO_FORMAT.md §5.2, §6.1).

import { millisFromCivil, type Millis } from '@simlab/kernel';

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `500ms`, `90s`, `5m`, `2h`, `1d`: an integer and a unit. */
export function parseDuration(text: string): Millis {
  const m = /^([0-9]+)(ms|s|m|h|d)$/.exec(text);
  if (!m) throw new Error(`not a duration: ${JSON.stringify(text)} (an integer and one of ms, s, m, h, d)`);
  return Number(m[1]) * (UNITS[m[2] as string] as number);
}

/** `2026-11-13T09:00:00Z`. */
export function parseStartTime(text: string): Millis {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/.exec(text);
  if (!m) throw new Error(`not a start time: ${JSON.stringify(text)} (YYYY-MM-DDTHH:MM:SSZ)`);
  const [, y, mo, d, h, mi, s] = m.map(Number) as [number, number, number, number, number, number, number];
  return millisFromCivil(y, mo, d, h, mi, s);
}

/** `2m`, `90s`, `1h30m` style text for messages. */
export function formatDuration(ms: Millis): string {
  if (ms % 3_600_000 === 0 && ms > 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0 && ms > 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}
