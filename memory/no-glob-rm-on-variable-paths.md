---
name: no-glob-rm-on-variable-paths
description: Don't run rm with a glob on a variable or relative path (e.g. rm -rf "$D"/* or capture/*); it needs the owner's manual approval
metadata:
  type: feedback
---

Don't write `rm` commands whose target is a glob under a variable or a relative path, such as
`rm -rf $S/capture/*` or `rm -rf capture/*` after a `cd`. Claude Code flags them as "Dangerous rm
operation on statically-unresolvable target" and the owner has to approve each one by hand.

**Why:** On 2026-11-15 (phase 01) cleanup commands of that shape interrupted the owner twice for
approval. Nothing was lost, but each prompt is an interruption, and a relative glob after a
failed `cd` could hit the repository.

**How to apply:** Leave temporary files in the session scratchpad, which is session-scoped. Don't
clean them up. When something must be removed, name one literal absolute path with no glob, or
have the script that made the temporary directory delete it (Python `tempfile.TemporaryDirectory`).
