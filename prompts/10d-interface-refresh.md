# Phase 10d — Interface refresh: a modern look, the lab panel in tabs, a floating X-ray

**Milestone** M1 · **Needs** 10c and the R3 run after Checkpoint A2 · Follow the session protocol in `CLAUDE.md`.

## Goal

My verdict at Checkpoint A2 (`docs/feedback-log.md`, 2026-11-17): the X-ray and the figures do
their job, but the interface around them "feels like old Bootstrap websites", the lab panel puts
the ticket, the check, the hints, the debrief and the solutions in one long scroll, and the
docked X-ray takes the terminal's width. Give the interface a look I would call modern, split the
lab panel into tabs, and let the X-ray float. Phase 12 builds every learning screen on the result,
so this comes first.

## Read first

`docs/feedback-log.md` (both runs). `docs/DESIGN.md` whole: this phase rewrites its §1 to §4 and
§7 and keeps §5 and §6 (states, the shape vocabulary, the honesty rules) unless the new look needs
a token changed. `docs/decisions.md` D-117 (the Instrument choice this phase reopens, at my
request) and the Checkpoint A2 decisions. `PLAN.md` §10. `memory/owner-environment.md`.
`apps/web/src/app/` as it stands, and the screenshots `npm run e2e` writes.

## Build

- **The look.** What I said when asked what "modern" means, all four at once: panes as floating
  rounded surfaces; fewer lines and more air (most 1px rules and bevels gone, separation by
  spacing and tone, flat controls, stronger type contrast); more color and depth (a stronger
  accent, gradient or glow on what is active, translucent surfaces where they help); and "show me
  options". What reads as Bootstrap today, from the screenshots: bordered buttons with a bevel
  and a shadow, a hairline around every region, gray slabs in the light theme, a native `select`.
  Early in the session, show me two or three directions as screenshots of the real workspace
  running the scheduling lab (check failed, one hint taken, the X-ray open), in both themes, and
  let me choose. Not mock-ups. Each direction must take a position on all three wishes, and they
  must differ in more than the accent color. In 10b I chose Instrument over Studio, which had
  rounded floating panes; say what each new direction keeps from either. Then apply the chosen
  one to every screen: workspace, lab list, editor overlay, popovers, dialogs, figures, the
  X-ray. Remove what was not chosen. Every size, color, radius, shadow and duration stays a token
  (`docs/DESIGN.md`). The terminal's own colors and font stay a terminal's, and the editor
  overlay stays in the code font.
- **Constraints the look must keep.** State colors and glyphs stay distinguishable without color
  (§5). Text contrast meets WCAG AA in both themes; measure it in a test for the token pairs in
  use. Motion rules of §4 hold: nothing decorative moves, so a glow or gradient is static.
  Translucency must not cost latency: the numbers of phase 10 and 10b hold (`npm run bench:web`).
  The terminal keeps at least 80 columns at 1440px with the lab panel open. Fonts stay bundled
  (D-117); a new font is a recorded decision.
- **The lab panel in tabs.** Ticket, Check, Hints, Debrief, Solutions, each in its own tab of the
  panel, one visible at a time, the ticket first. A tab shows what it holds before I open it (the
  check's score, hints taken of how many) and says when it has something new. Opening Debrief
  before solving and opening Solutions still ask first and are still recorded; an empty tab
  explains what will appear there. The actions (Check, Hint, Reset) stay reachable from every
  tab, and running one shows its result (Check opens the Check tab). Tabs follow the ARIA tabs
  pattern with arrow keys; the existing chords keep working. Each tab keeps its own scroll
  position. Design the tab strip so phase 12 can add a lesson's steps without a second mechanism.
- **A floating X-ray.** An option beside the docked pane: the X-ray as a panel that floats over
  the workspace inside the page, moved by its header and resized from its edges, by pointer and
  by keyboard. It never leaves the window (also after the window shrinks), remembers its place,
  size and mode, and has a control to dock it again. While it floats, the terminal keeps its full
  width and typing still goes to the terminal unless the X-ray was clicked. The chord and the top
  bar button open it in the mode last used. Opening it is still recorded as help. A separate
  browser window was considered and not asked for; do not build it.
- **Tests.** Browser tests for the tabs (each tab's content, the badges, the confirmations, keys,
  scroll kept), for the floating X-ray (drag, resize, kept inside the window, remembered after a
  reload, docking, the terminal's column count unchanged while it floats, typing still reaches
  the shell), and the existing ones adapted. Layout measured at device scale factors 1, 1.25 and
  1.5. The tests added by the R3 run after Checkpoint A2 keep passing: selecting an entity never
  moves the drawing, the editor is in the code font, the page itself never scrolls.

## Not in this phase

The home screen and the other learning screens (phase 12), though the tokens and the tab strip
must already serve them. The "Why?" inspector, the timeline and assist levels (phase 13). New
content. Any change to the view contract or the providers.

If the phase does not fit one session, stop once the chosen look is applied to every screen with
the gate green, and record the tabs or the floating X-ray as carry-over.

## Exit criteria

- I chose the look from directions shown as screenshots of the real workspace, and every screen
  uses it. `docs/DESIGN.md` describes it; nothing of the old look is left in `styles.css`.
- Ticket, Check, Hints, Debrief and Solutions are tabs; I can reach every one by keyboard, and
  what gives the answer away still asks first.
- The X-ray floats, moves, resizes, stays inside the window, docks again, and remembers all of it.
- `npm run e2e` passes; the latency numbers still hold with the X-ray docked and floating; the
  build still works offline; reduced motion still makes change instant.
- Include screenshots of the workspace (X-ray closed, docked, floating), a debrief, the lab list
  and the editor overlay, in both themes. Say what was not verified on Chrome for Windows and ask
  me to confirm it.
