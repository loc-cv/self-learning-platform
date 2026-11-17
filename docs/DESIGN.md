# Design language

The look of Simlab, for the interface and the views alike (`PLAN.md` §6.5, §10). Written in phase
10b. The tokens live in `apps/web/src/app/styles.css`; this file says what they are for and the
rules for using them. A literal size, color, radius, shadow or duration in a stylesheet is a defect:
use a token, or add one here first.

## 1. What it answers

The owner's verdict at Checkpoint A (`docs/feedback-log.md`, 2026-11-17): the type and the spacing
were dull, everything was flat with no depth, and nothing showed the system. Color was not the
complaint. Two directions were shown as screenshots of the real workspace running the scheduling
lab with the X-ray open, each in both themes:

- **Instrument**: IBM Plex Sans, a compact rhythm, panes joined edge to edge as tonal layers with
  hairline bevels, small radii, a faint dot grid behind the views, a blue accent.
- **Studio**: Inter, a roomier rhythm, panes as rounded islands floating on a darker floor with soft
  shadows, larger titles, a violet accent.

The owner chose **Instrument** (2026-11-17). Studio's tokens and its font were removed.

**Reopened at Checkpoint A2** (2026-11-17, `docs/feedback-log.md`): the owner finds the result
"like old Bootstrap websites" and wants floating rounded panes, fewer lines and more air, more
color and depth. Phase 10d shows new directions and rewrites §1 to §4 and §7 for the chosen one.
Until then this file describes the interface as it is.

The system on screen is what gives the product its character: the views carry the look, and the
chrome around them stays quiet.

## 2. Type

| Token | Size | Use |
|---|---|---|
| `--fs-xs` | 11px | micro-labels (uppercase, tracked), meta text, chips |
| `--fs-sm` | 12px | secondary text, code in prose, controls in dense rows |
| `--fs-base` | 13px | controls, lists, the default for chrome |
| `--fs-body` | 14px | prose: tickets, hints, debriefs |
| `--fs-lg` | 15px | item titles in lists |
| `--fs-xl` | 18px | pane titles (the lab's title) |
| `--fs-2xl` | 22px | page titles (the lab list) |

- **Faces.** `--font-ui` is IBM Plex Sans, bundled (`apps/web/src/app/fonts.ts`, weights 400, 500,
  600, every subset including Vietnamese; D-117), so it looks the same on Windows and Linux and needs
  no network. `--font-code` is the system's monospace stack for code in prose and for names in views
  (a Pod name, a path). The terminal and the editor keep their own font and colors (`theme.ts`).
- **Weights.** `--fw-regular` 400 for prose, `--fw-medium` 500 for controls and names,
  `--fw-semibold` 600 for titles, headers and states. Bold (700) only for a mark inside a control.
- **Leading.** `--lh-tight` 1.25 for titles, `--lh-body` 1.6 for prose; chrome uses 1 or 1.5.
- **Tracking.** Uppercase micro-labels take `--tracking-caps` (0.08em); titles are tightened
  slightly (−0.012em). Nothing else is tracked.

## 3. Spacing, sizes, radii

- **Rhythm.** A 4px base: `--sp-1` 4, `--sp-2` 8, `--sp-3` 12, `--sp-4` 16, `--sp-5` 20, `--sp-6`
  24, `--sp-8` 32. Padding inside a pane is `--pane-pad` (20px); sections inside a pane are separated
  by `--sp-5` with a hairline.
- **Fixed heights.** `--topbar-h` 42px, `--tabs-h` 34px (the terminal tabs and the X-ray's header
  share it, so the panes' headers line up).
- **Radii.** `--r-sm` 4px (inputs, small chips), `--r-md` 6px (buttons, code blocks, cards),
  `--r-lg` 8px (popovers). Pills are fully round. Views use their own radii for their shapes (§6).

## 4. Surfaces, depth and motion

**Surface levels** (colors per theme): `--bg` is the floor (level 0), `--surface` a pane (1),
`--surface-2` something raised inside a pane: a card, an input, a host in a view (2), `--surface-3`
hover and pressed (3), `--raised` an overlay: popovers, dialogs, the cards of a view.

**Depth.** Panes meet edge to edge and are told apart by tone and a hairline, with a bevel
(`--bevel`, a one-pixel highlight along the top edge) that makes each read as a layer. Shadows are
for things above the floor's plane: `--elev-1` buttons, `--elev-2` raised cards, `--elev-3`
popovers, dialogs and floating notes. The X-ray's canvas sits a step below the panes
(`--canvas-bg`) with a faint dot grid (`--canvas-grid`), so its boxes read as objects on a bench.

**Motion.** Something moves only when the world changed or the learner acted.

| Token | Duration | What |
|---|---|---|
| `--motion-fast` | 120ms | hover and press feedback on controls |
| `--motion-base` | 200ms | a change of state (color, glyph), a meter |
| `--motion-move` | 420ms | an entity that moves or a container that resizes in a view |
| `--motion-enter` | 280ms | an entity that appears (fade in) |
| `--motion-exit` | 320ms | an entity that leaves (fade out in place) |

Easing: `--ease-standard` (cubic-bezier(0.2, 0, 0, 1)) for everything that arrives or moves,
`--ease-exit` for what leaves.

Rules:

- **What may move.** In a view: an entity that appears, leaves, changes state or moves to another
  container; a container that must grow or shrink for that, and what lies below it in the same
  band, in the same transition. In the interface: the hover and press feedback of a control, the
  check meter filling, the spinner while a world is built.
- **What never moves.** Anything decorative: no idle animation, no pulsing, no traffic drawn where
  the model has none (`PLAN.md` §6.5 "Honesty"). An entity keeps its place while others come and go
  (the renderer remembers slots, §6). The terminal never animates.
- **Reduced motion.** The system's `prefers-reduced-motion`, or the Motion setting set to
  Reduced, makes every change instant: durations go to zero and leaving entities are removed at once.
  The setting can only reduce motion, never turn it on against the system.

## 5. States

One set of colors for the states of things, shared by the interface (check results, notices, the
clock when paused) and the views. A view never shows a state by color alone: each state also has a
glyph.

| State | Meaning | Glyph | Dark | Light |
|---|---|---|---|---|
| healthy | doing what it is declared to do | filled dot | `#62c88f` | `#23824e` |
| progressing | on its way there, expected to arrive without help | open arc | `#4fc3d9` | `#0f8296` |
| degraded | partly working, or blocked waiting for something that will not change by itself | triangle | `#e5b452` | `#9a6a0c` |
| failed | not working | cross | `#f07a7a` | `#c0392f` |
| unknown | the model cannot tell | question mark | `#9aa4b0` | `#6b7480` |
| selected | the learner's selection in a view | 2px outline | the text color | the text color |

Each state has a tint (`--state-<name>-bg`) for chips and failing cards. `--ok`, `--warn` and
`--bad` in the interface are the healthy, degraded and failed colors. The accent (`--accent`, blue)
is for actions and focus, never for a state; focus rings are the accent, the selection in a view is
the text color, so neither is mistaken for progressing.

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
follows the pane, so a pane that loses height to the facts of a selection shows less at the bottom
and nothing rescales (D-129).

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

- **Panel.** The canvas's bench (`--canvas-bg`, the dot grid) in a box with `--r-md` and a hairline,
  a micro-label title above the drawing for each side of a comparison. A comparison sits side by
  side from 760px of figure width and stacked below that, which is how it reads in the lab panel;
  the enlarge button opens the figure in a dialog (`--raised`, `--elev-3`) wide enough for two.
- **Caption** above the figure in `--fs-body` medium; **notes** below it in `--fs-sm`, each with its
  number in a round badge; a cited divergence id in a small code chip after the note.
- **Marks.** A highlight is a dashed 2px outline in the accent around the entity; a note's number
  is a round badge in `--accent-bg` on the entity's top right; a comparison's change is a badge on
  the top left: `+` only on the right and `•` changed (both in `--accent-bg`), `−` only on the left
  (`--text-muted`), and an entity only on the left keeps a dashed outline but full strength: in a
  comparison of start and solved it is the broken state the figure is about. Marks
  point; they are never a state, so they use the accent and never a state color.
- **Scenes.** Under the drawing: previous and next, the frame count in tabular figures, Replay, and
  one dot per frame (past frames `--text-faint`, the current one the accent). The frame's caption
  below, with its number in a badge, in a region a screen reader announces. Moving between frames
  is the renderer's ordinary motion; Replay advances on its own only when motion is not reduced.
- **Diagrams** use the shapes and states as world views do; an author picks the state that tells
  the story (a normal scheduling pass is drawn healthy).

## 7. Surfaces of the interface

- **Top bar**: the floor's darkest pane, `--topbar-h`, brand, lab title, clock, notices, the
  X-ray toggle (pressed state in the accent), settings.
- **The page** never scrolls: the workspace fills the window and only panes scroll (D-130).
- **Lab panel**, **terminals**, **X-ray**: three panes edge to edge, resizable by their splitters.
  In a narrow X-ray the filter shrinks first and the "counts as help" note goes; the title and
  the buttons stay.
  The X-ray is closed at the start of every attempt (it is help); its width is remembered.
- **Popovers and dialogs**: `--raised` with `--elev-3` and `--r-lg`.
- **The lab list** (the current home until phase 12): a page title in `--fs-2xl`, items as cards.

Phase 12's home and learning screens are built from the same tokens: the type scale and states
already cover mastery, due counts and scores (a meter uses the state colors; a count uses
`--font-code` with tabular figures).
