---
name: cap-output-of-data-files
description: Never print an attempt log, the progress log or a failing test's received value uncut; one record per keystroke fills the context
metadata:
  type: feedback
---

Cut every command whose output can contain a data file or an assertion diff: `| cut -c1-200 | head -40`,
or count lines instead of printing them. This covers `data/attempts/*.jsonl`, `/api/attempts/<id>`,
`/api/progress`, and Playwright's failure output when an `expect(text).toContain(…)` fails on such a body.

**Why:** In phase 12 (2026-11-17) a test asserted on the text of an attempt log; the failure printed
the whole log, one JSON record per keystroke with a full check report in several of them, into the
session. Claude's own observation, not something the owner said.

**How to apply:** Assert on a count or a parsed field of a log, never on its text. When reading a
test log, grep for the verdict lines first. Related: [[zsh-glob-aborts-checks]].
