# R3 — Feedback and gap triage (repeatable)

**Needs** phase 10 · Run after each checkpoint and whenever notes pile up · Follow the session protocol in `CLAUDE.md`.

## Goal

Turn what I ran into while using the platform into fixes, most valuable first. Two sources:
`FEEDBACK.md`, where I write impressions and problems in my own words, and `data/gaps.jsonl`, where
the simulator logs every `[sim]` notice I hit.

## Read first

`FEEDBACK.md`. A summary of `data/gaps.jsonl` grouped by command and count (summarize it with a
script; don't read the raw file). `STATUS.md` known gaps. `docs/FIDELITY.md` divergence register.

## Do

1. **Classify every entry** as one of:
   - *wrong*: the simulator did something the real system doesn't (output, behavior, timing, error).
     These come first: they teach false things.
   - *missing*: a real command, flag or behavior that isn't simulated.
   - *feel*: latency, terminal behavior, editor, layout, friction in the learning flow.
   - *content*: an unclear ticket, a wrong check, a leaking hint, a weak debrief, bad difficulty.
   - *idea*: a feature request beyond the plan.
2. **Reproduce** each *wrong* and *feel* entry in script mode, the terminal player or the browser
   before changing anything. If my note is ambiguous, ask me rather than guess what I meant.
3. **Verify against a source** for each *wrong* entry: the oracle, the real tool on this
   workstation, or upstream source. If the simulator turns out to be right, say so and explain,
   and consider whether a debrief should teach it.
4. **Propose a triage list** to me before fixing: each entry, its class, the evidence, the
   estimated size, and what you intend to do in this session versus defer. Ask me to confirm or
   reorder. Entries that belong to a planned phase are deferred to it and noted in that phase's
   section of `STATUS.md`.
5. **Fix** what was agreed, each with a transcript or test that would have caught it. For *wrong*
   entries, add a golden case when the oracle can produce one.
6. **Close the loop**: move handled entries of `FEEDBACK.md` into `docs/feedback-log.md` with what
   was done; mark handled gap-log groups; update the divergence register for anything deliberately
   left different; put *ideas* worth keeping into `STATUS.md` as candidates, not commitments.

At a checkpoint, also give me a short, honest assessment: does the evidence say the approach is
working, what are the biggest risks you see now, and would you change the order of upcoming phases.

## Exit criteria

- Every entry is classified and either fixed with a test, deferred to a named phase, or declined
  with a reason I accepted.
- No *wrong* entry is left without a fix or an explicit divergence entry.
- `FEEDBACK.md` holds only unhandled entries; `STATUS.md` records this run under R3.
