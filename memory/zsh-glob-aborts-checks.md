---
name: zsh-glob-aborts-checks
description: In the zsh tool shell an unmatched glob aborts a for-list or fails its command, even with 2>/dev/null; confirm checks ran before reporting something absent
metadata:
  type: feedback
---

The Bash tool runs the owner's zsh, where an unmatched glob is an error. In a `for` loop over a
glob it aborts the whole command line, so every later step is skipped. As a plain argument it fails
that command with `no matches found` and later steps still run. `2>/dev/null` does not hide it.

**Why:** In an earlier version of this project (2026-11-03) this led to telling the owner that a
full search found no Go install when the search never ran; the owner was right that only `PATH`
was stale. Saved then, lost when the project restarted on 2026-11-13, restored on 2026-11-15 after
checking that the current workstation behaves the same.

**How to apply:** Before reporting that something is absent, confirm each check produced output
and its exit code makes sense. Run globs that may not match inside `bash -c '…'` or with
`setopt nullglob`, or last, and split independent checks.
