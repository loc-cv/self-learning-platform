---
name: commit-messages-name-the-plan
description: Every commit message starts with the plan it belongs to, e.g. "[master-plan] phase 00: …"
metadata:
  type: feedback
---

Commit messages name the plan the work belongs to, as a bracketed prefix before the phase:
`[master-plan] phase NN: <summary>`. The plan in `PLAN.md` ("Simlab — Master Plan") is
`master-plan`; repeatable prompts use `[master-plan] R3: <summary>`.

**Why:** The owner asked for this on 2026-11-13, after the phase 00 commit was written as plain
`phase 00: …`: "This will make other future plans more manageable." More plans are expected, and
their phase numbers would otherwise collide in the history.

**How to apply:** Use the prefix on every commit in this repository. When a new plan is created,
give it a short kebab-case slug, record it in `CLAUDE.md` next to the commit rule, and use that
slug as the prefix. The slug `master-plan` was my choice, not the owner's wording; change it if
they name the plan differently.
