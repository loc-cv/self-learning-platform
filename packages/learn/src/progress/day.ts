// The learner's day (docs/LEARNING_MODEL.md §8): which day a moment belongs to. Days are what
// "due today", the time box and streaks count in. Time is always an argument.

import type { LearnerSettings } from './events.ts';

export const DAY_MS = 86_400_000;

/** Days since the epoch in the learner's local time, a day starting at `dayStartHour`. */
export function dayIndex(at: number, settings: Pick<LearnerSettings, 'utcOffsetMinutes' | 'dayStartHour'>): number {
  return Math.floor((at + settings.utcOffsetMinutes * 60_000 - settings.dayStartHour * 3_600_000) / DAY_MS);
}
