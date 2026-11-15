// The `[sim]` notice (docs/FIDELITY.md §4.2). Every notice is formatted here; programs never write
// the prefix themselves. The notice says, in the simulator's own voice, that something real is not
// simulated; it never imitates the real tool. Phase 03 adds a distinct style when stderr is a
// terminal.

/** `[sim] <program>: <what> is not simulated yet` plus optional hint lines, each prefixed. */
export function simNotice(program: string, what: string, hints: readonly string[] = []): string {
  return [`[sim] ${program}: ${what} is not simulated yet`, ...hints.map((h) => `[sim] ${h}`)].map((l) => `${l}\n`).join('');
}

/** The exit status of a notice, reserved for the simulator (§4.2). */
export const SIM_STATUS = 250;
