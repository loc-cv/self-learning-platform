# Authoring

How to write content items. The format is `docs/SCENARIO_FORMAT.md`; this guide is about judgement.
Phase 14 completes it (tickets, hints, debriefs, variation, the curriculum map). Phase 10c wrote the
part on figures. Lessons, cards and exams are specified in `docs/LEARNING_MODEL.md` §2; the fixture
pack `packages/content/fixtures/learning/` has a valid example of each to copy from.

## Figures

`PLAN.md` §5 "Show, then tell": a simulator can show what a real system hides, and a picture next to
a few words teaches more than the words alone. A debrief that is only text is a defect, and content
validation refuses one.

### When a figure

- **Every debrief opens with one**, for every variant: the cause and the fix, before any prose. If a
  fault family has three causes, write three figures under `when`, each showing the facts of its
  cause.
- **A ticket may carry one** when a real ticket would attach a sketch: the setup, the symptom the
  ticket already states, or what is wanted (a diagram of the objects to build). Never the cause.
- **A concept that is not world state** (how the scheduler filters, then scores; what a rolling
  update may do with four replicas) gets a diagram or a scene.
- **No figure** when it would only repeat the prose with boxes, and never in an exam task.

### Which kind

| You want to show | Kind |
|---|---|
| The world as it is: the broken state, the result | `view` of `start`, `solved` or `now` |
| What the fix changed | `compare` of `start` and `solved` |
| The learner's own result next to the reference | `view` of `now`, beside one of `solved` |
| Something that happens over time: a rollout stalling, a controller converging | `scene` |
| An idea with no world behind it | `diagram` |

A comparison of `now` and `solved` marks every Pod as different, because generated names differ
between worlds; prefer two views. A scene runs for real, so give it the smallest world that shows
the idea (`world.setup` of its own) rather than the item's baseline when the baseline is already
broken; four replicas show `maxSurge` and `maxUnavailable`, three do not.

### Scenes that show a cause

A scene's frame can be drawn at the moment a component decided something, and quote the decision
(`docs/SCENARIO_FORMAT.md` §11.2.1): `at: { actor: kube-scheduler, about: "Pod/web-*" }` and
`{{@cause}}` in the caption.

- Use it where the lesson is the decision itself: the scheduler rejecting each node, a Service
  finding no ready Pod, a container exiting and the kubelet backing off. The per-candidate lines
  (each node with its reason) appear under the caption; do not repeat them in prose.
- Put the step that triggers the decision in the frame, and steps that wait in a later frame.
- The quoted text is the simulator's explanation, not kubectl output. Where the learner should
  recognise what a real tool prints (an Event's message, a STATUS column), show that with a fact
  or name the command in the prose.
- The learner's own run needs no scene: the debrief replays the attempt from its input log, with
  its causes, after your figures (`docs/LEARNING_MODEL.md` §14). It looks at what your debrief's
  first figure of a world looks at, so give that figure the focus the story needs.

### Choosing what it shows

- **Focus narrowly**: the namespace and the kinds the story needs. Pods bring their Nodes with them.
- **Show only the facts the point needs**, and cut list facts to the keys that matter
  (`{ fact: Labels, keys: [disktype] }`). A card with six labels hides the one that matters.
- **In a ticket, check what the glyphs give away.** States and statuses are always drawn: a ticket
  about a stuck rollout should not include the Pods whose image pull fails. Write `show: []` and
  add facts only when the ticket states them.
- **Point with notes**, one idea each, on the entity they explain. A note is where a sentence that
  used to be prose about one object goes ("kubeadm taints the control plane node, so it was
  rejected too").
- **Say where the simulator is simpler.** If a figure shows something the model holds more coarsely
  than reality (no admission-added tolerations, reachability instead of packets), add a note with
  `divergence: DIV-NNN` from `docs/FIDELITY.md`.

### How much text may remain

The prose keeps what a figure cannot say: why (the mental model, a rule such as "a toleration
permits, it never attracts"), where to look next time (the command that shows it), what would also
have worked and why the grader refused it, and "in reality" notes. Everything that describes a
state ("the node is labelled…, the Deployment selected…, so no node matched") belongs to the figure,
its caption and its notes.

As a measure: when phase 10c rewrote the three labs around figures, each debrief's prose went to at
most half its length, with nothing it taught lost. Aim for that.

- **Caption**: one sentence, what to see. Not a description of every box.
- **Alt text**: what the figure shows, in plain words, complete enough to stand in for it. It is
  what a screen reader reads and what `npm run lab` prints in a terminal.
- **Scene captions**: one or two sentences per frame, saying what changed and why it matters.

### Checklist

- Every variant's debrief starts with a figure, and a figure exists for every cause.
- `npm run content:check` passes: every figure resolves on every sampled seed.
- The ticket's figure shows nothing the ticket does not state.
- Words in captions, notes and diagrams follow the grounding rule like any prose (`CLAUDE.md` rule 3).
- Look at the debrief in the web app at the default panel width, and enlarged.
