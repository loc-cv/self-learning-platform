---
name: go-builds-stay-local
description: When compiling vendored upstream Go code as an oracle, set GOCACHE, GOPATH and GOTELEMETRY=off so nothing is written outside the repo or scratchpad
metadata:
  type: feedback
---

Compiling the vendored upstream Go code (Go 1.27.4 is on the workstation) is a good oracle for
ports, but the Go toolchain writes outside the repository by default: the build cache
(`~/.cache/go-build`), modules (`~/go`) and local telemetry counters (`~/.config/go/telemetry`).

**Why:** `CLAUDE.md` forbids changing the workstation outside the repository. In phase 07a
(2026-11-16) an agent kept the build cache in the scratchpad but Go still updated its telemetry
counters in the home directory.

**How to apply:** run Go with `GOCACHE`, `GOPATH` and `GOMODCACHE` in the session scratchpad,
`GOFLAGS=-mod=vendor`, `GOTELEMETRY=off` and `GOTOOLCHAIN=local`, and say so in any agent brief
that may build Go. Related: [[no-glob-rm-on-variable-paths]].
