---
name: subagent-model-choice
description: Set the model explicitly on every subagent; Sonnet for search, reading and mechanical work, Opus only for design and debugging
metadata:
  type: feedback
---

Every Agent call names its model. Sonnet does search, reading upstream source, summarizing logs
and mechanical edits; Opus does design, porting decisions and debugging. A brief for an Opus agent
tells it to hand its own bulky reading and grep to Sonnet subagents.

**Why:** In phase 08 (2026-11-16) seven parallel agents were launched without a `model`, so all
inherited Opus. The owner noticed and asked whether that respected CLAUDE.md's rule ("Use Sonnet
subagents for search and mechanical work; escalate to Opus for debugging and design"). It did
not: the rule was known, but the choice was never made per agent. Two of the seven (info/config,
generators) could have been Sonnet, and none were told to delegate reading.

**How to apply:** Before spawning, decide the model per agent and pass it. Put the delegation
rule in every brief (a shared brief file is a good place). CLAUDE.md's "During" section now says
the same. Related: [[fix-wrong-things-freely]].
