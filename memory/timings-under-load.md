---
name: timings-under-load
description: The workstation often runs the owner's other CPU jobs; compare timings by profile or back to back, and never git stash while agents work in the tree
metadata:
  type: feedback
---

Wall-clock timings on this workstation vary by a factor of two or more: the owner runs other
CPU-heavy jobs on it (load average 11 was seen during phase 13, 2026-11-17), and parallel agents
running Playwright add to it.

**Why:** In phase 13 `npm run content:check` looked twice as slow as the previous commit, twice.
CPU profiles of both commits were equal function by function; the difference was load. Claude's
own observation. In the same session a `git stash` round trip was run while a subagent was still
editing the tree; nothing was lost, but a write in that window would have conflicted on pop.

**How to apply:** Before calling something slower, check `uptime`, then compare `node --cpu-prof`
profiles (inclusive time per function) of the two versions, or run them back to back several
times. Stash or switch branches only when no agent is working in the repository. Related:
[[cap-output-of-data-files]].
