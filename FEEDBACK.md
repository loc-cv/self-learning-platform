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
- The page no longer shifts upward when Solutions opens (Solutions is a tab since phase 10d). This one was not reproduced here, so the
  fix is a guess at the cause: say so if it happens again, with the window size and zoom level.

Built on 2026-11-17 in phase 10d, tested only in headless Chromium on Linux (100%, 125%, 150%):

- The look (Quiet): how IBM Plex Sans and the translucent popovers render with Windows' font
  smoothing, and whether the blur behind the floating X-ray or a popover costs anything on your GPU.
- `Ctrl+Shift+,` and `Ctrl+Shift+.` go to the lab panel's previous and next tab; Escape returns to
  the terminal. Nothing outside the page should take them, but only your machine can tell.
- The floating X-ray: dragging its header and its edges with your mouse or touchpad, and that it
  comes back where you left it after a reload. `Ctrl+Shift+G` takes its move handle (arrow keys
  move, Shift+arrows resize, Escape returns); Chrome uses that chord for "find previous".
- At your window size and scaling, the terminal keeps 80 columns with the lab panel open and the
  X-ray docked.
