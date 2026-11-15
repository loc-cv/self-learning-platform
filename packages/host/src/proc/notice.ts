// The `[sim]` notice (docs/FIDELITY.md §4.2). Every notice is formatted here; programs never write
// the prefix themselves. The notice says, in the simulator's own voice, that something real is not
// simulated; it never imitates the real tool. On a terminal each line is written in yellow
// (`styleNotice`, docs/decisions.md D-026); a pipe or a file gets it plain.

/** `[sim] <program>: <what> is not simulated yet` plus optional hint lines, each prefixed. */
export function simNotice(program: string, what: string, hints: readonly string[] = []): string {
  return [`[sim] ${program}: ${what} is not simulated yet`, ...hints.map((h) => `[sim] ${h}`)].map((l) => `${l}\n`).join('');
}

/** The exit status of a notice, reserved for the simulator (§4.2). */
export const SIM_STATUS = 250;

/**
 * The terminal style of a notice: each line yellow (SGR 33), reset after it (SGR 0). The web UI
 * and the terminal player render the same bytes. Chosen in phase 03 (docs/decisions.md D-026).
 */
export function styleNotice(text: string): string {
  return text.replace(/^(.*)$/gm, (line) => (line === '' ? line : `\x1b[33m${line}\x1b[0m`));
}
