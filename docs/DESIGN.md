# Design language

The look of Simlab, for the interface and the views alike (`PLAN.md` §6.5, §10). Written in phase
10b; §1 to §4 and §7 rewritten in phase 10d for the look chosen there. The tokens live in
`apps/web/src/app/tokens.css`; this file says what they are for and the rules for using them.
`apps/web/src/app/styles.css` holds rules only: a literal size, color, radius, shadow or duration
there is a defect, and `tokens.test.ts` fails on one. Use a token, or add one here first.

## 1. What it answers

**Checkpoint A** (2026-11-17, `docs/feedback-log.md`): the type and the spacing were dull,
everything was flat with no depth, and nothing showed the system. Phase 10b showed two directions
and the owner chose *Instrument* (IBM Plex Sans, compact, panes joined edge to edge as tonal layers
with hairline bevels) over *Studio* (Inter, roomier, rounded island panes).

**Checkpoint A2** (2026-11-17): the result felt "like old Bootstrap websites": bordered buttons
with a bevel and a shadow, a hairline around every region, gray slabs in the light theme, a native
select. Asked what modern means, the owner said: panes as floating rounded surfaces; fewer lines
and more air; more color and depth; and "show me options". Phase 10d showed three directions as
screenshots of the real workspace running the scheduling lab (check failed, one hint taken, the
X-ray docked and floating), each in both themes:

| | Floating panes | Lines and air | Color and depth |
|---|---|---|---|
| **Glass** (Inter) | translucent panes, 18px corners, 12px apart, over a floor with still color glows | no rules; a pill strip of tabs | a violet-to-blue gradient on the primary action, a glow on the selected tab, glass everywhere |
| **Quiet** (IBM Plex Sans) | opaque tonal panes, 12px corners, 8px apart, on a flat floor | no rules but the line under the selected tab; compact | one indigo accent, no gradient or glow; depth by tone; translucency only on what floats |
| **Stage** (Geist) | the terminal as the floor to the window's edge, the other panes as cards with 24px corners and deep shadows | no rules; larger type, pill controls | a mint-to-cyan gradient with dark ink, the selected tab inverted |

The owner chose **Quiet, "with less rounded boxes"** (2026-11-17, D-132): the corners below are
tighter than the ones shown. Glass and Stage, their tokens and their fonts were removed. From
Instrument, Quiet keeps the font, the compact rhythm, the tonal layers and a blue-family accent;
from Studio, panes as separate rounded surfaces with a gap between them.

What the look is, in one paragraph: panes are rounded surfaces that float on a darker floor with a
small gap; areas are told apart by space and tone, never by a rule; controls are flat; one accent
marks actions and what is selected; only what floats above the panes is translucent. The system on
screen is what gives the product its character: the views carry the look, and the chrome around
them stays quiet.

## 2. Type

| Token | Size | Use |
|---|---|---|
| `--fs-xs` | 11px | micro-labels (uppercase, tracked), meta text, chips, badges |
| `--fs-sm` | 12px | secondary text, code in prose, controls in dense rows |
| `--fs-base` | 13px | controls, lists, tabs, the default for chrome |
| `--fs-body` | 14px | prose: tickets, hints, debriefs |
| `--fs-lg` | 15px | item titles in lists, headings in prose and popovers |
| `--fs-xl` | 18px | pane titles (the lab's title) |
| `--fs-2xl` | 24px | page titles (the lab list) |
| `--fs-score` | 26px | the one big number of a pane (the check's score, a count on the home screen) |

- **Faces.** `--font-ui` is IBM Plex Sans, bundled (`apps/web/src/app/fonts.ts`, weights 400, 500,
  600, every subset including Vietnamese; D-117, kept by D-132), so it looks the same on Windows
  and Linux and needs no network. `--font-code` is the system's monospace stack for code in prose,
  for names in views (a Pod name, a path) and for the editor overlay. The terminal keeps a
  terminal's font and its sixteen colors (`theme.ts`); only its background and default foreground
  are tokens (`--term-bg`, `--term-fg`), so its surface is the pane it sits in.
- **Weights.** `--fw-regular` 400 for prose, `--fw-medium` 500 for controls and names,
  `--fw-semibold` 600 for titles (`--fw-title`), the selected tab, headers and states. Bold (700)
  only for a mark inside a badge.
- **Contrast of type.** Three strengths of text: `--text` for what is read, `--text-muted` for
  labels and secondary text, `--text-faint` for identifiers nobody needs to read twice (an item's
  id). All three meet WCAG AA (4.5:1) on every surface they are used on, in both themes;
  `tokens.test.ts` measures the pairs.
- **Leading.** `--lh-tight` 1.25 for titles, `--lh-snug` 1.45 for chrome that wraps, `--lh-body`
  1.6 for prose, `--lh-1` for single lines.
- **Tracking.** Uppercase micro-labels take `--tracking-caps` (0.08em); titles are tightened
  slightly (`--tracking-title`). Nothing else is tracked.

## 3. Spacing, sizes, radii

- **Rhythm.** A 4px base with half steps: `--sp-0h` 2, `--sp-1` 4, `--sp-1h` 6, `--sp-2` 8,
  `--sp-2h` 10, `--sp-3` 12, `--sp-3h` 14, `--sp-4` 16, `--sp-5` 20, `--sp-6` 24, `--sp-8` 32,
  `--sp-10` 40, `--sp-12` 48. Padding inside a pane is `--pane-pad` (20px). Sections inside a pane
  are separated by space, and blocks that belong together sit on a tinted surface.
- **The gap.** `--gap` (8px) is the space between panes and between the panes and the window. The
  gap between two panes is the handle that resizes them; it shows a short accent bar on hover and
  on focus.
- **Fixed heights.** `--topbar-h` 44px; `--tabs-h` 38px (the terminal tabs, the X-ray's header and
  the lab panel's tab strip share it); controls are `--ctl-h` 30px and `--ctl-h-sm` 26px; a button
  that holds only an icon is square.
- **Radii.** `--r-sm` 3px (code chips, small marks), `--r-md` 5px (cards inside a pane, code
  blocks), `--r-lg` 6px (popovers, list cards, the bench of a view), `--r-pane` 8px (panes, the
  floating X-ray, dialogs), `--r-ctl` 5px (buttons, selects, segmented controls). Badges, state
  chips and skill chips are pills (`--r-pill`). Views use their own radii for their shapes (§6).
- **Lines.** `--line` 1px, `--line-2` 2px (focus rings, the selected tab's line, a selection in a
  view), `--line-3` 3px (the splitter's bar). Other fixed sizes of small things are the `--size-*`
  tokens, named after what they size.

## 4. Surfaces, depth and motion

**Surface levels** (colors per theme): `--bg` is the floor (level 0), `--pane-bg` a pane (1),
`--surface-2` something raised inside a pane: a card, a check, a hint (2), `--surface-3` a chip or
a track inside that (3), `--raised` a dialog. `--ctl-bg` and `--ctl-bg-hover` are a control's fill;
`--ghost-hover` is the hover of a control that has no fill at rest.

**Depth** comes from tone first. A pane is a step lighter than the floor and carries a one-pixel
ring of very low contrast (`--pane-shadow`), which is an edge, not a rule between regions. Shadows
are for what floats above the panes: `--elev-2` a raised card, `--elev-3` popovers, menus, dialogs,
the facts card of the X-ray, `--float-shadow` the floating X-ray. The X-ray's canvas sits a step
below its pane (`--canvas-bg`) with a faint dot grid (`--canvas-grid`), so its boxes read as
objects on a bench.

**Translucency** is for what floats, and only there: `--overlay-bg` with `--overlay-blur` on
popovers, the select's menu, the facts card and the notes over the terminal; `--float-bg` on the
floating X-ray; `--scrim` behind a dialog and behind the lab list when it lies over the workspace.
Panes are opaque. The blur costs nothing measurable: `npm run bench:web` reports the same latency
with the X-ray closed, docked and floating.

**Color.** One accent, indigo: `--accent` as text and icons, `--accent-fill` (with `--accent-ink`)
for the primary action, `--accent-soft` for a pressed or chosen control, `--focus-ring` for
keyboard focus. There is no gradient and no glow. The accent is never a state (§5).

**Lines.** The interface draws one: the line under the selected tab of a tab strip. Everything
else that used to be a rule is a gap or a change of tone; where scrolled text meets the actions
below it, it fades out (a mask) instead of ending at a border.

**Motion.** Something moves only when the world changed or the learner acted.

| Token | Duration | What |
|---|---|---|
| `--motion-fast` | 120ms | hover and press feedback on controls |
| `--motion-base` | 200ms | a change of state (color, glyph), a meter |
| `--motion-move` | 420ms | an entity that moves or a container that resizes in a view |
| `--motion-enter` | 280ms | an entity that appears (fade in) |
| `--motion-exit` | 320ms | an entity that leaves (fade out in place) |
| `--motion-spin` | 900ms | one turn of the spinner while a world is built |

Easing: `--ease-standard` (cubic-bezier(0.2, 0, 0, 1)) for everything that arrives or moves,
`--ease-exit` for what leaves.

Rules:

- **What may move.** In a view: an entity that appears, leaves, changes state or moves to another
  container; a container that must grow or shrink for that, and what lies below it in the same
  band, in the same transition. In the interface: the hover and press feedback of a control, the
  check meter filling, the spinner while a world is built, a panel following the pointer that
  drags it.
- **What never moves.** Anything decorative: no idle animation, no pulsing, no traffic drawn where
  the model has none (`PLAN.md` §6.5 "Honesty"). Tabs switch at once. An entity keeps its place
  while others come and go (the renderer remembers slots, §6). The terminal never animates.
- **Reduced motion.** The system's `prefers-reduced-motion`, or the Motion setting set to
  Reduced, makes every change instant: durations go to zero and leaving entities are removed at once.
  The setting can only reduce motion, never turn it on against the system.

## 5. States

One set of colors for the states of things, shared by the interface (check results, notices, the
clock when paused) and the views. A view never shows a state by color alone: each state also has a
glyph.

| State | Meaning | Glyph | Dark | Light |
|---|---|---|---|---|
| healthy | doing what it is declared to do | filled dot | `#62c88f` | `#1f7a49` |
| progressing | on its way there, expected to arrive without help | open arc | `#4fc3d9` | `#0c7789` |
| degraded | partly working, or blocked waiting for something that will not change by itself | triangle | `#e5b452` | `#8d610a` |
| failed | not working | cross | `#f07a7a` | `#bd352c` |
| unknown | the model cannot tell | question mark | `#9aa4b0` | `#606774` |
| selected | the learner's selection in a view | 2px outline | the text color | the text color |

Each state has a tint (`--state-<name>-bg`) for chips and failing cards. `--ok`, `--warn` and
`--bad` in the interface are the healthy, degraded and failed colors. The light theme's values were
darkened slightly in phase 10d so each reads at 4.5:1 on its own tint (`tokens.test.ts`). The
accent (`--accent`, indigo) is for actions and focus, never for a state; focus rings are the
accent, the selection in a view is the text color, so neither is mistaken for progressing. In the
interface a state is never color alone either: a check has ✓, ✗ or !, a tab's badge has its count,
a solved lab says "solved".

Who decides the state: the view provider, in its domain's terms (`packages/k8s/src/view/provider.ts`
writes down why an unschedulable Pod is degraded and a Pod in ImagePullBackOff failed). The status
word next to it is the domain's own (`Pending`, `Ready`, `2/3`), taken from the code that prints it
for the real tool.

## 6. Views

### 6.1 The shape vocabulary

A view model (`packages/kernel/src/view.ts`) describes each kind by one shape from a fixed list.
The renderer knows the shapes and nothing about any domain; adding a domain means mapping its kinds
onto these, not adding shapes.

| Shape | What it is | Kubernetes | Linux host | Load balancer | Network path | Drawn as |
|---|---|---|---|---|---|---|
| `host` | something things run on, with its own boundary | Node (on its machine) | machine | the balancer's machine | router, host at either end | an elevated box with a header strip |
| `scope` | a logical grouping that holds declarations | Namespace | user, cgroup slice | — | subnet, VLAN | a dashed region |
| `workload` | a declaration that keeps instances running | Deployment, ReplicaSet, DaemonSet, Job | systemd service unit | backend pool | — | a card with a second card behind it (it manages several) |
| `process` | a running instance | Pod | process | backend server | — | a plain card |
| `endpoint` | an address traffic is sent to | Service | listening socket | frontend, VIP | interface with its address | a pill |
| `store` | where data or configuration is kept | PersistentVolumeClaim, ConfigMap, Secret | file system, file | — | — | a card with a curved top |
| `rule` | something that admits, denies or steers | NetworkPolicy, Role | firewall rule | balancing rule | route, ACL | a card with a cut corner |

Why these seven. Containment needs two shapes, because a physical boundary (where things run) and a
logical one (where things are declared) are drawn differently and filtered differently: Pods sit on
Nodes but belong to Namespaces. The things inside split by what they do in a picture of a system:
something declares, something runs, something is reached, something keeps data, something decides.
Every kind in the CKA and CKAD curricula, a Linux host's units and processes, a load balancer's
frontends and pools, and a path's interfaces and routes falls into one of them; a kind that seems to
fit two takes the role it plays in the pictures where it matters (a Service is reached, so it is an
endpoint, though it also selects).

**Relations** are typed from a fixed list too: `owns`, `selects`, `routesTo`, `runsOn`, `mounts`,
`uses`. Containment is not a relation: an entity names its container. A `selects` relation whose
target also receives a `routesTo` from the same source is drawn once, as the route; a selection
with no route is dashed, which is how a Service that selects a Pod that is not ready looks.

### 6.2 Layout

Our own code (`apps/web/src/view/layout.ts`), deterministic, no layout library. The picture reads
top to bottom:

1. **Scopes**, stacked at full width, each holding its declarations (workloads, then endpoints,
   stores, rules) in a grid, owners before what they own.
2. **The unplaced lane**: entities whose kind normally sits in a container (`placedIn`) and has none,
   one lane per kind, captioned by the kind's `unplaced` text ("Pods with no node").
3. **Hosts** side by side, wrapping to more rows when they do not fit; nested hosts (a Node on its
   machine) stack inside at full width; what runs on them fills a grid of cards.
4. Anything else at the top level.

Cards are 46px tall and between 140 and 210px wide, filling the columns of their container. Names
keep their start and their end with an ellipsis in the middle, where generated names differ.

**Stability.** Each container remembers which entity sat in which slot. An entity keeps its slot;
a newcomer takes the first free slot; a leaving entity keeps its slot while it fades out, and the
slot is free after that. Containers do not shrink while the memory lives, so nothing moves up when
something leaves. A change of filter or a resize of the pane lays everything out afresh.

### 6.3 The renderer

SVG, by our own code (`apps/web/src/view/ViewCanvas.tsx`). Each entity is a group keyed by its id
and placed with a CSS transform, so a move, a resize and a change of state are CSS transitions;
arrivals fade in with the Web Animations API. Containers are drawn first, then the relations, then
the cards, so links pass behind cards and over containers. Relations are faint until something is
selected; the selection's relations then stand out and everything unrelated recedes.

Interaction: click or Enter selects and Escape clears; Tab and the arrow keys move between entities
(the nearest one in that direction); `+` and `−` zoom, `0` fits everything, `F` focuses the
selection; the wheel scrolls, Ctrl+wheel zooms, dragging the background pans. Every entity has an
accessible name: kind, name, status and state.

Selecting never moves the drawing. The visible part is kept as a corner and a zoom; its height
follows the pane, so a pane that changes height shows more or less at the bottom and nothing
rescales (D-129). The facts of a selection lie on a card over the drawing's lower edge and take no
height from it (D-138).

### 6.4 Honesty

A view shows what the model holds and nothing else (`PLAN.md` §6.5). Words a real tool also prints
come from the code that prints them: a Pod's status is `printPod`'s STATUS cell, the fact labels are
the printers' column names. A test compares the X-ray with `kubectl get pods -A -o wide` and
`kubectl get nodes` on the same world (`packages/k8s/src/view/provider.test.ts`). Another test keeps
every Kubernetes word out of the view contract, the renderer and the X-ray pane
(`apps/web/src/view/nodomain.test.ts`).

### 6.5 Figures

Figures in tickets and debriefs (`docs/SCENARIO_FORMAT.md` §11) are drawn by the same renderer in
its **still** mode: as tall as their content at the pane's width (and never shorter while shown, so
stepping a scene does not make the page jump), no zoom, pan or selection, every relation drawn at
its resting strength, and the facts the figure names drawn under each card's status or each
container's header, one line per fact or per entry of a list fact (three at most, then "+N more"),
the label in `--font-ui`, the value in `--font-code` at `--fs-xs`, shortened in the middle to fit.

- **Panel.** The canvas's bench (`--canvas-bg`, the dot grid) in a box with `--r-lg` and no border,
  a micro-label title above the drawing for each side of a comparison. A comparison sits side by
  side from 760px of figure width and stacked below that, which is how it reads in the lab panel;
  the enlarge button opens the figure in a dialog (`--raised`, `--elev-3`, over `--scrim`) wide
  enough for two.
- **Caption** above the figure in `--fs-body` medium; **notes** below it in `--fs-sm`, each with its
  number in a round badge; a cited divergence id in a small code chip after the note.
- **Marks.** A highlight is a dashed 2px outline in the accent around the entity; a note's number
  is a round badge in `--accent-solid` on the entity's top right; a comparison's change is a badge on
  the top left: `+` only on the right and `•` changed (both in `--accent-solid`), `−` only on the left
  (`--surface-3`), and an entity only on the left keeps a dashed outline but full strength: in a
  comparison of start and solved it is the broken state the figure is about. Marks
  point; they are never a state, so they use the accent and never a state color.
- **Scenes.** Under the drawing: previous and next, the frame count in tabular figures, Replay, and
  one dot per frame (past frames `--text-faint`, the current one the accent). The frame's caption
  below, with its number in a badge, in a region a screen reader announces. Moving between frames
  is the renderer's ordinary motion; Replay advances on its own only when motion is not reduced.
- **Diagrams** use the shapes and states as world views do; an author picks the state that tells
  the story (a normal scheduling pass is drawn healthy).

## 7. Surfaces of the interface

- **The page** never scrolls: the workspace fills the window and only panes scroll (D-130).
- **Top bar**: on the floor, with no surface of its own: brand, the lab panel's toggle, the lab
  list, the lab's title, the clock, notices, the X-ray toggle (pressed: `--accent-soft`), full
  screen, settings, shortcuts.
- **Panes.** The lab panel, the terminals and the docked X-ray lie side by side with `--gap`
  between them, resizable by the gaps. **The terminal keeps 80 columns** while the window has room
  for them: the docked X-ray gives way first, down to its minimum (320px), then the lab panel
  (300px); at 1440px all three fit (D-136). Below 900px the lab panel lies over the terminal.
- **Tab strip** (`TabStrip` in `ui.tsx`): the ARIA tabs pattern. One tab stop; the arrow keys move
  and select, Home and End go to the ends; a click selects without taking focus from the terminal.
  The tabs share the strip's width; in a narrow strip they drop their icons, then the strip
  scrolls sideways, so it holds any number of tabs. A tab can carry an icon, a badge (what it
  holds: a score, a count, with a spoken form) and a dot when something arrived since it was last
  open. A lesson's pages are tabs of this strip (below), not a second mechanism.
- **Lab panel**: the lab's kicker, title and id; the tab strip with **Ticket, Check, Hints,
  Debrief, Solutions**; one tab panel at a time, each with its own scroller, so every tab keeps
  its scroll position; the actions (Check, Hint, Reset) under every tab. An action opens the tab
  that shows its result, and the panel if it was hidden. The Check tab's badge is the score
  (`3/5`, with a check mark once solved), the Hints tab's the hints taken of how many. An empty
  tab says what will appear in it. **What gives the answer away asks first, in its tab**: Debrief
  before the lab is solved, and Solutions; both show a lock until then, and both are recorded as
  before. Reset asks above the actions. `Ctrl+Shift+,` and `Ctrl+Shift+.` go to the previous and
  next tab from anywhere and put the focus on it; Escape returns to the terminal (D-135).
- **X-ray**: closed at the start of every attempt (it is help). It opens in the mode last used:
  **docked** as the third pane, or **floating** over the workspace; a control in its header
  switches. Floating, it is moved by its header and resized from its edges and corners with the
  pointer, and from its move handle with the keyboard (`Ctrl+Shift+G` takes the handle; arrow keys
  move, Shift+arrow keys resize, in steps of 24px; Escape returns to the terminal); all of it stays inside the workspace, also when the window shrinks; its place and
  size are remembered and come back when the window has room again (`floating.ts`, D-137). While
  it floats the terminal keeps its full width, and neither dragging it nor its buttons take the
  keyboard from the terminal. In a narrow X-ray the filter shrinks first and the "counts as help"
  note goes; the title and the buttons stay. The filter is the interface's own select (`Select` in
  `ui.tsx`), not the system's.
- **Editor overlay**: the terminal's surface (`--term-bg`) in the code font, a file bar above and
  a status bar below, no borders.
- **Popovers, menus and dialogs**: `--overlay-bg` with `--overlay-blur` and `--elev-3`; a dialog is
  `--raised` over `--scrim`.
- **Home** (`Home.tsx`, phase 12): a page on the floor that scrolls inside the workspace, two
  columns from 960px of width. Left: **Today's session** (the one primary button, the time box as
  a segmented control, due and new counts in `--font-code`, what the session holds as a bar of
  segments against the time box and a numbered list), then mastery **by curriculum domain** (per
  exam, a strip whose segments are the domains' shares of the exam, a meter per domain) and **by
  skill** (a meter and a status per skill). Right: unfinished attempts, the streak with 28 days of
  activity as cells, reviews due over the next 14 days as bars, recent mistakes. Mastery, due
  counts and trends are drawn; every drawing has a text alternative. A status is a glyph and a
  word in the state's color with no tint behind it (the tints fail AA on a card in the light
  theme): mastered is the healthy dot, learning the progressing arc, due the degraded triangle,
  new a ring, locked a lock. Quantities that are not states (the activity cells, the session
  bar's segments) use accent-hued tokens (`--heat-*`, `--seg-*`). A first run says what will
  happen instead of showing zeros.
- **Content browser** (`Browser.tsx`): every item as a card with its kind, difficulty, target
  time, skills and state; filters by track, skill, curriculum domain, kind and state. It is a page
  from home and a sheet over the workspace (`Ctrl+Shift+O`), where Escape closes it.
- **Top bar, while a session runs**: the session's pips (done, current, ahead), its count, the
  minutes left of the time box, **Next** once the item is finished or given up (**Skip** before),
  and **Stop**. The brand goes home. The language of prose is a segmented control: EN, VI, EN·VI.
- **Confidence**: Check on an unsolved lab first shows five buttons in the action area, 1
  (guessing) to 5 (certain); the keyboard is in it, a digit answers, Enter skips, Escape cancels.
- **Giving up**: the Solutions tab, and the Debrief tab before the lab is solved, say that
  opening them is giving up, on the warning tint; the kicker then carries "gave up".
- **Debrief**: after a solve, first a text area for the root cause in the learner's words. Then,
  in this order: the debrief's figures, the checks, "Your commands" beside "Reference solution"
  (two columns from 620px of panel width, stacked below), the learner's explanation as a quote,
  the prose, the rating, the button that moves on.
- **Rating**: the grade's name in its state color (Again failed, Hard degraded, Good and Easy
  healthy) with the reason in words, the four grades as a segmented control (one click replaces
  the grade), and the next review as "in 5 days" with the date in `--font-code`.
- **Lesson**: the lab panel with the lesson's pages as tabs, numbered, each with the icon of its
  gate (a prediction, a task, reading), a check mark once done, a lock while the page before it
  is open. A prediction and a guided task are cards on `--surface-2` with an accent kicker;
  choices are full-width buttons with a letter, chosen in `--accent-soft`, and after locking in
  the right one carries ✓ on the healthy tint and a wrong pick ✗ on the failed tint.
- **Card**: with no world, one pane centered on the floor (`--card-max`), the prompt a step
  larger than prose; with a world, the same body in the lab panel's place. Digits pick a choice
  and, after the reveal of a self-graded card, the grade.
- **Languages**: side by side, each text unit is a row of two cells, English left, Vietnamese
  right behind a 2px tone line, so the two stay aligned whatever their lengths. A unit with no
  current Vietnamese carries a pill: "EN only", or "VI outdated" on the warning tint. A figure is
  drawn once; its captions and notes carry the other language under them, muted. An item with no
  sidecar says "English only" once, in its kicker.
- **A view laid out afresh is drawn in place** (D-162): no move transition when a pane gets its
  width or the filter changes.
