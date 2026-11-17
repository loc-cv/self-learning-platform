# Feedback log

What each run of `prompts/R3-feedback-and-gap-triage.md` did with the entries of `FEEDBACK.md`
and the groups of the gap log. Newest run first. `FEEDBACK.md` itself holds only what is still
open.

## 2026-11-17 — R3 after Checkpoint A2

The owner played the labs again with the X-ray and the figures (phases 10b and 10c). Nothing was
said against the figures or what the X-ray shows. No entry was *wrong* (the simulator teaching
something false); all six are about the web app. Reproduced in headless Chromium on the
workstation.

### Feedback entries

| Entry (the owner's words, shortened) | Class | Evidence | Outcome |
|---|---|---|---|
| "Fit everything" is buggy: after it, the layout jumps whenever I click a component in the X-ray | feel | Reproduced: after Fit, selecting a Pod moved node01 from x=1081, y=418, 158 px wide to x=1106, y=310, 109 px wide; deselecting moved it back. Any zoom did the same. The stored visible part kept the pane's old height; the facts of a selection shorten the pane and the SVG rescaled | **Fixed** (D-129): the height follows the pane. `e2e/xray.spec.ts` selects as opened, after Fit and after a zoom, and measures |
| The font inside the vim editor is not monospace | feel | Found in the code: the editor's theme asked for `var(--mono)`, a token phase 10b renamed to `--font-code`, so the text fell back to IBM Plex Sans. Indentation in YAML does not line up in a proportional font | **Fixed**: `--font-code` for the text, vim's command line and its input. `e2e/workspace.spec.ts` compares the width of `iiiiiiiii` and `MMMMMMMMM` and the computed family |
| Once, not reproducible: the first click on Solutions shifts the whole page upward, leaving a blank area at the bottom | feel | Not reproduced (1440×900, 1536×730 at 125%, 1280×600 at 150%; X-ray open and closed; after a check and a hint). The suspect: `scrollIntoView`, which also scrolls the page when it has any spare height | **Fixed defensively** (D-130): the panel scrolls only its own scroller and the page cannot scroll at all. The cause on the owner's machine is not proven; reopen if it happens again |
| Put Hint, Debrief and Solutions in their own sub tabs instead of one sidebar | feel | Agreed from a screenshot: a failed check pushes the ticket out of view and the hints below the fold | **Plan changed**: phase 10d |
| An option to open the X-ray as a floating window | idea | With three panes at 1440 px the terminal is about 50 columns and `kubectl get pods` wraps | **Plan changed**: phase 10d. Asked which kind: a floating panel in the page, not a separate browser window |
| Make the UI more modern; it feels like old Bootstrap websites | feel | Agreed from screenshots, most in the light theme: bordered buttons with bevel and shadow, a hairline around every region, gray slabs, a native select. Asked what modern means: floating rounded panes, fewer lines and more air, more color and depth, and "show me options" | **Plan changed**: phase 10d reopens the look chosen in 10b; new directions as screenshots, the owner chooses (D-131, `PLAN.md` §15) |

Confirmed by the owner on Chrome for Windows: Ctrl+W, Ctrl+T and Ctrl+N reach the shell and vim in
full screen and in the installed app window. The other three confirmations stay in `FEEDBACK.md`.

### Gap log groups (1 record, 1 group)

| Group | Records | Finding | Outcome |
|---|---|---|---|
| readline's `digit-argument` (`\e1`, Alt+1) | 1 | *missing*. Real readline starts a numeric argument and shows `(arg: 1)` | Deferred to **22a**; written into its prompt. Marked handled |

### Also fixed

- The X-ray's header at its narrowest width (320 px): the title wrapped to two lines and the
  buttons ran out of the pane. The filter now shrinks first and the note hides
  (`e2e/xray.spec.ts`).
- The lab panel's automatic scrolling ignored reduced motion (always smooth); it now follows it.

## 2026-11-17 — R3 after Checkpoint A

The owner played the three labs in Chrome on Windows 11 (`memory/owner-environment.md`). Each
*feel* entry was tried in headless Chromium on the workstation at 100%, 125% and 150% display
scaling. No entry was *wrong* (the simulator teaching something false).

### Feedback entries

| Entry (the owner's words, shortened) | Class | Evidence | Outcome |
|---|---|---|---|
| Typing on the terminal feels good; for the supported commands it feels pretty real | — | Phase 10's latency numbers held (`npm run bench:web`: p95 11.8 ms, keystroke echo p95 0.5 ms) | The realism criteria of `PLAN.md` §2 hold for the slice. Nothing to do |
| Ctrl+Shift+1…9 works except Ctrl+Shift+1 | feel | Not reproduced: both switch here. On the owner's machine the chord does nothing at all, so something outside the page takes it | **Fixed around it**: Ctrl+Shift+PageUp/PageDown go to the previous and next terminal (D-112). The cause on that machine is unknown |
| Ctrl+Shift+C opens DevTools | feel | Reproduced: the page claimed the chord only when the terminal had a selection | **Fixed** (D-112): claimed every time; it also copies text selected in the lab panel or the editor. `e2e/workspace.spec.ts`, `shortcuts.test.ts` |
| In vim, Escape takes me out of the browser tab; Ctrl+C is needed for normal mode | feel | Not reproduced. The owner then found the cause: the Vimium extension takes Escape and blurs the editor; with it disabled, Escape works | **Not a simulator fault.** The shortcut list now says to exclude the page in such an extension (D-113). A page cannot stop an extension that sees the key first |
| Ctrl+W closes the tab instead of deleting a word | feel | Chrome and Edge keep Ctrl+W, Ctrl+T and Ctrl+N in an ordinary tab and never show them to the page. Chromium's source reserves nothing in app windows and almost nothing in full screen | **Fixed by a way out** (D-113): full screen with the keyboard locked (Ctrl+Shift+F or the top bar), and the page is installable as an app window; in both the keys reach the shell and vim. The page's side is tested; the owner confirms on Chrome for Windows |
| Too much text, little or no visual aid; boring, does not stand out | content | Debriefs are 300 to 500 words of prose; the format had no figure block | **Plan changed**: phases 10b and 10c (`PLAN.md` §5 "Show, then tell", §6.5, §8, §15; D-115) |
| The debrief lacks a visual presentation | content | Phase 13 promised only "the causal chain" in the debrief | **Plan changed**: figures open every debrief from 10c; phase 13 adds the replay of the attempt |
| An advanced or dynamic visual presentation of the system, also for Linux, load balancers, networking | idea | The X-ray of phase 13 was the seed, but late, optional and counted as help | **Plan changed**: one view contract and renderer for every domain (10b), scenes (10c), replay and causes (13); R4 and 34 require a view provider |
| The UI looks a bit bland | feel | Agreed from screenshots. Asked what is meant: dull type and spacing; flat, no depth; nothing shows the system. Not color | **Deferred to 10b**: a design language chosen by the owner from two directions shown as screenshots (`docs/DESIGN.md`) |
| Some boxes do not center their content, like the × that closes a terminal, on hover | feel | Reproduced: the icon sat 3 px right of center (the button kept the browser's default padding); the + sat 4 px above the tabs' line. No other control was off by more than half a pixel | **Fixed** (`styles.css`), with a browser test that measures every icon button at three display scales |

### Gap log groups (26 records, 9 groups)

| Group | Records | Finding | Outcome |
|---|---|---|---|
| nginx 1.27.5 and 1.28.3: build compiler not captured | 16 | *missing*. Only nginx 1.31.8 and 1.14.2 have their "built by" log line captured (D-098). The records have no item: they come from development runs of the terminal player | Deferred to **16a** (already its carry-over: `images:capture` records the line for every nginx tag) |
| `k`: command not found | 3 | The simulator is right for a host where nobody defined the alias. The exam's hosts do define it: "`kubectl` with `k` alias and Bash autocompletion" (docs.linuxfoundation.org/tc-docs/certification/tips-cka-and-ckad). So the topology lacks a preset | Deferred to **22a**, which makes bash read `~/.bashrc`; written into its prompt |
| `vim` without a file name | 2 | *missing* | Deferred to **22a**; written into its prompt |
| `less` | 1 | *missing* | Phase **22b**, as planned |
| `kubectl top nodes` | 1 | *missing* | Phase **18b**, as planned |
| the `for` loop; `End`: command not found | 2 | A prompt meant for another project was pasted into the terminal. `for` is phase **22a**; `End` is bash's real answer | Nothing else to do |
| `check`: command not found | 1 | The simulator is right; checking is a button and Ctrl+Shift+Enter | Declined |

All nine groups were marked handled (`npm run gaps:summary`, added by this run: D-114).

### Also fixed

- `docs/decisions.md`: D-103 to D-111 sat under the heading of phase 09; they have their own
  heading now. D-108 said the chosen chords "are not reserved by browsers", which is why
  Ctrl+Shift+C was left unclaimed; corrected.
