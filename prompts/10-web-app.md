# Phase 10 — Web app: terminal, lab panel, editor overlay

**Milestone** M1 · **Needs** 09 · Follow the session protocol in `CLAUDE.md`.

## Goal

The first version of the product I'll actually open: a browser workspace with a real-feeling
terminal next to the lab ticket. It completes the thin vertical slice, after which I judge whether
the simulation feels real before any breadth is built.

## Read first

`PLAN.md` §2, §10, §11. `docs/ARCHITECTURE.md` on the engine API and time drivers.

## Build

- **`apps/web`** with Vite and React. All assets bundled; nothing loaded from a network at runtime.
- **Engine in a Web Worker** behind a small message protocol: terminal bytes both ways, control
  (start item, reset, check, hint, advance, speed), and editor requests. The wall-clock time driver
  lives here.
- **Terminal**: xterm.js wired to the engine TTY, resize handling, copy and paste, several terminal
  tabs on the same machine, focus that never gets lost while typing.
- **Editor overlay**: CodeMirror 6 with Vim keybindings for `vim`, `vi` and `kubectl edit`; `:w`,
  `:q`, `:wq`, `:q!` map to save and close; YAML highlighting; a setting for plain keybindings.
- **Lab workspace**: item list, ticket panel (Markdown), check with per-check results, hint ladder,
  reset, debrief with the reference solution, elapsed time.
- **Session safety**: the input log is kept in browser storage so a reload resumes the lab by
  replay. Durable storage comes with phase 11.
- **Gap notices**: a small indicator listing `[sim]` notices hit in this session.
- **Look and feel**: a calm dark theme by default with a light one, keyboard-first, resizable
  panes, readable at laptop width. Take design seriously; I will look at this for hundreds of hours.
- `npm run dev` and `npm start`. A Playwright smoke test that opens a lab, types a command, runs
  the check and sees a result.

## Not in this phase

Home screen, daily session, progress (phases 11, 12). X-ray view and speed controls beyond a basic
pause (phase 13). Exam mode (phase 31).

## Exit criteria

- All three labs are solvable in the browser, including one that uses `kubectl edit` and one that
  edits a file with `vim`.
- Reloading the page mid-lab resumes with the same terminal content and world.
- Typing latency is imperceptible; p95 for read commands stays under 50 ms in the browser, measured.
- The build works with the network disabled.
- The smoke test passes. Include screenshots of the workspace in your summary.

After this phase comes **Checkpoint A**: tell me how to start the app, what to try, and to write my
impressions in `FEEDBACK.md`.
