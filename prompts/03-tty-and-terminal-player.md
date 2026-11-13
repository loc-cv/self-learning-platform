# Phase 03 — TTY, completion and the terminal player

**Milestone** M1 · **Needs** 02 · Follow the session protocol in `CLAUDE.md`.

## Goal

Make the simulated shell usable by a human and by Claude. After this phase I can sit in the
simulated machine from my real terminal, and every later session can exercise what it builds for
real instead of only through unit tests.

## Read first

`PLAN.md` §6.2, §10. `docs/ARCHITECTURE.md` TTY and editor protocol.

## Build

- **TTY in the engine** (`packages/host`): bytes in, bytes out. Prompt in the usual
  `user@host:cwd$` form, cursor movement, insert and delete, Ctrl-A, Ctrl-E, Ctrl-U, Ctrl-K, Ctrl-W,
  Ctrl-L, Ctrl-C, Ctrl-D, history with up and down and Ctrl-R, multi-line continuation for open
  quotes and heredocs, terminal width handling. All of it testable headlessly by feeding keys.
- **Completion framework**: Tab completes commands, paths and variables, and lets a program register
  its own completer. Double Tab lists candidates the way bash does.
- **Editor protocol**: programs `vim`, `vi` and `nano` ask the front end to edit a file's content
  and receive the result. Headless runs supply the content. Define it so `kubectl edit` can reuse it.
- **`apps/cli` terminal player**: `npm run play -- --topology <name> [--seed N]` attaches my real
  terminal in raw mode to a simulated machine, with the wall-clock time driver. For the editor
  protocol it opens the real `$EDITOR` on a temporary copy and writes the result back. It records the
  input log and can replay one (`--replay <file>`).
- **Script mode**: `npm run sim -- --topology <name> -c "<commands>"` (or a script file) runs
  commands non-interactively and prints the output, with flags to advance virtual time between
  commands. This is how Claude sessions verify behavior.
- A minimal topology of one plain machine so the player has something to run before Kubernetes exists.

## Not in this phase

The web UI. kubectl completion (phase 08). `ssh` between machines (phase 25a).

## Exit criteria

- Key-level tests cover editing, history, Ctrl-R, Ctrl-C during a blocking command, and completion
  with zero, one and many candidates.
- I can run the player, use pipes and redirects, edit a file with my real editor, and find the
  change in the simulated filesystem.
- Recording a session and replaying it yields the same world hash.
- Script mode works and `CLAUDE.md` documents both commands.
