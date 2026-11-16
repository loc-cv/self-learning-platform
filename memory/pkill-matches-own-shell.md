---
name: pkill-matches-own-shell
description: pkill -f with a pattern that also appears in the running shell command kills that shell (exit 144); find PIDs first, check what they are, then kill them
metadata:
  type: feedback
---

`pkill -f "main.ts --port 4318"; …` in one Bash call killed the call's own shell, because the
shell's command line contains the pattern; the tool reported exit code 144 and nothing else ran.

**Why:** Phase 10b (2026-11-17) lost two test runs to it, and the follow-up cleanup stopped an
`npm start` server on port 4317 that may have been the owner's, without checking first.

**How to apply:** List candidates with `ps -o pid,args` (or `ss -ltnp` for a port), read what each
one is, and kill only test servers this session started, by PID. Never stop a server on the
owner's port 4317 without asking. Related: [[no-glob-rm-on-variable-paths]].
