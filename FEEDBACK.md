# Feedback

Write impressions and problems here in your own words, then run
`prompts/R3-feedback-and-gap-triage.md`. Handled entries move to `docs/feedback-log.md`.

## To confirm on Chrome for Windows

Fixed on 2026-11-17 after Checkpoint A, tested only in headless Chromium:

- Ctrl+Shift+C no longer opens DevTools.
- Ctrl+Shift+PageUp / PageDown switch terminals where Ctrl+Shift+1 does nothing.
- With Vimium: exclude `http://127.0.0.1:4317/*` in its options, then Escape works in vim.

Fixed on 2026-11-17 after Checkpoint A2:

- X-ray: after "Fit everything" (or a zoom), clicking a component no longer moves the drawing.
- The vim editor's text is in the terminal's monospace font.
- The page no longer shifts upward when Solutions opens. This one was not reproduced here, so the
  fix is a guess at the cause: say so if it happens again, with the window size and zoom level.
