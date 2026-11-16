---
name: next-prompt-at-phase-end
description: End every phase report with the next prompt file's path on its own line, ready to copy; the owner manages sessions from a phone
metadata:
  type: feedback
---

When a phase (or repeatable prompt run) is done, the report ends with the next prompt to run, as
its path alone in a code block, e.g. `prompts/10c-figures-and-scenes.md`, taken from the order in
`STATUS.md`. If the next step is a checkpoint rather than a prompt, say so and name the prompt after it.

**Why:** The owner asked for it on 2026-11-17, after phase 10b: they manage the session from their
phone and want to copy the name conveniently.

**How to apply:** Check the file exists before naming it. Put nothing else in that code block.
Related: [[commit-messages-name-the-plan]].
