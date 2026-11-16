---
name: owner-environment
description: The owner uses the web app from Chrome on Windows 11 with the Vimium extension, not from the Linux workstation; test UI at 125% and 150% scaling
metadata:
  type: user
---

The owner plays the labs in Chrome on a Windows 11 machine, not in a browser on the Linux
workstation where the code is built. That browser has the Vimium extension (vim keys on every
page), and the screen is very likely scaled above 100%.

**Why:** Checkpoint A's feedback (2026-11-17) had four keyboard problems and one layout problem
that headless Chromium on Linux did not show by itself: Chrome acted on Ctrl+Shift+C and
Ctrl+W, something outside the page took Ctrl+Shift+1, Vimium took Escape in the vim overlay, and
an icon was visibly off-center. The Playwright headless shell has no browser window, so the
browser's own shortcuts never fire in tests.

**How to apply:** For anything keyboard-related in `apps/web`, check which keys the browser acts
on unless the page prevents the default, and which it never shows to a page in an ordinary tab
(`docs/decisions.md` D-112, D-113); assert `defaultPrevented` in browser tests. Measure layout at
device scale factors 1, 1.25 and 1.5. Say plainly what could not be verified on Windows and ask
the owner to confirm it. A browser extension can take a key before any page code runs; the page
cannot prevent that, only explain it. Related: [[fix-wrong-things-freely]].
