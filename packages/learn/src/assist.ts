// Assist levels (PLAN.md §5 "Faded guidance", §6.5, §10): how much of the live view of the world
// an attempt may use. The exam gives none, so it must be possible to practice without it. A level
// is set per item and globally; the lower of the two applies, and an exam's tasks get none.

export const ASSIST_LEVELS = ['off', 'view', 'full'] as const;

/**
 * - `full`: the X-ray with its "why" inspector and timeline;
 * - `view`: the X-ray shows the world, but explains nothing: no "why", no timeline;
 * - `off`: no X-ray. The workspace shows the terminal and the ticket's own figures, nothing else.
 */
export type Assist = (typeof ASSIST_LEVELS)[number];

export const isAssist = (x: unknown): x is Assist => typeof x === 'string' && (ASSIST_LEVELS as readonly string[]).includes(x);

/** The lower of two levels. */
export function lowerAssist(a: Assist, b: Assist): Assist {
  return ASSIST_LEVELS.indexOf(a) <= ASSIST_LEVELS.indexOf(b) ? a : b;
}

/**
 * The level an attempt runs at: the item's (default `full`) capped by the learner's global
 * setting; `off` for an item played as an exam task.
 */
export function assistFor(item: { assist?: Assist }, global: Assist = 'full', exam = false): Assist {
  return exam ? 'off' : lowerAssist(item.assist ?? 'full', global);
}

/** Whether a level allows what `needs` names. */
export function assistAllows(level: Assist, needs: Exclude<Assist, 'off'>): boolean {
  return ASSIST_LEVELS.indexOf(level) >= ASSIST_LEVELS.indexOf(needs);
}
