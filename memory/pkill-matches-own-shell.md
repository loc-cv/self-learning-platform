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

**Also `pgrep -f` in a wait loop (2026-11-17, phase 13).** A subagent left six background shells of
the form `while pgrep -f "node_modules/.bin/playwright test" >/dev/null; do sleep 5; done; …`.
Each loop's own command line contains the pattern, so `pgrep -f` always finds it and the loop never
ends; the owner saw "6 shells" and could not restart the session. Wait on a PID instead
(`while kill -0 $PID 2>/dev/null`), or on the result file, or write the pattern so it cannot match
itself (`pgrep -f "[p]laywright test"`). Put this in the brief of any agent that runs Playwright,
and before reporting a phase done, list this session's child shells and stop the stuck ones by PID.
