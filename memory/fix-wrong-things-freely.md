---
name: fix-wrong-things-freely
description: Standing permission to fix anything in the repo that is wrong or no longer relevant, without asking, even outside the current task; report it
metadata:
  type: feedback
---

Fix anything in this repository that is wrong or no longer relevant without asking first, even
outside the current task, and say what changed in the report and the `STATUS.md` handoff note.

**Why:** The owner granted this on 2026-11-04, after a session held back a two-line doc
correction to ask about it: they would rather have the repo correct than be asked about each fix,
and teaching something false is the worst failure of this project. The permission was lost when
the project restarted on 2026-11-13; the owner confirmed on 2026-11-15 that it still applies.

**How to apply:** Make the fix under the usual rules (tests, sources, provenance) and list it.
It does not cover design: a change that contradicts `PLAN.md` or reopens a decision in
`docs/decisions.md` still goes to the owner, though a wrong fact in a decision's reasoning can be
corrected. `CLAUDE.md` (session protocol, "During") states the same rule.
