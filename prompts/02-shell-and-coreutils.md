# Phase 02 — Shell and first coreutils

**Milestone** M1 · **Needs** 01 · Follow the session protocol in `CLAUDE.md`.

## Goal

A bash-subset shell that executes against a simulated machine, with the first set of standard
tools. I work in this shell all day, so pipes, redirects, quoting and heredocs must behave exactly
as my fingers expect. Build it on a real parser so it can grow; a regex-based command splitter
would have to be thrown away.

## Read first

`PLAN.md` §6.2. `docs/ARCHITECTURE.md` program interface, streams and pipelines.

## Build

- **Language**: lexer, parser and AST for simple commands, pipelines, lists (`;`, `&&`, `||`),
  redirections (`>`, `>>`, `<`, `2>`, `2>&1`, `&>`), heredocs and here-strings, single and double
  quotes, backslash escapes, comments, variable assignment and expansion (`$VAR`, `${VAR}`,
  `${VAR:-default}`), `$?`, command substitution `$(…)`, tilde and glob expansion, aliases.
  Expansion happens in bash's order.
- **Execution**: program lookup through `PATH` and executable stubs; exit statuses; streaming
  pipelines in virtual time, so a blocking producer can feed a consumer; interruption.
- **Builtins**: `cd`, `pwd`, `echo`, `printf`, `export`, `unset`, `alias`, `unalias`, `source`,
  `exit`, `type`, `history`, `true`, `false`, `test` and `[`.
- **Programs, required**: `ls`, `cat`, `mkdir`, `rm`, `cp`, `mv`, `touch`, `grep`, `head`, `tail`,
  `wc`, `sort`, `uniq`, `cut`, `tr`, `tee`, `sleep`, `date`, `env`, `which`, `clear`, `base64`.
  Support the flags people use daily; anything else is a `[sim]` notice.
- **Programs, if the session has room**: `ln`, `chmod`, `chown`, `seq`, `basename`, `dirname`,
  `whoami`, `hostname`, `id`.
- **Unsupported syntax** (loops, functions, arithmetic, job control for now) gives a `[sim]` notice
  naming the construct. Implement the notice and gap-log interface from `docs/FIDELITY.md` here, as
  shared host infrastructure.
- **Transcript tests**: create the transcript format and runner (setup, commands, expected output
  and exit status) used by every later phase.

**Ground truth.** This workstation runs real bash 5.3 and GNU coreutils. Get expected output and
error text by running the real command in a temporary directory, then freeze it in a transcript and
tag it `golden-verified`. Don't write expected output from memory.

## Not in this phase

Line editing, history navigation and completion (phase 03). `sed`, `awk`, `jq`, `find`, `xargs`,
control flow (phases 22a, 22b). `systemctl` and node tools (phase 25a). `kubectl`.

## Exit criteria

- Transcripts pass for: quoting and expansion cases, pipelines of three or more stages,
  redirections including `2>&1` ordering, heredoc into a pipeline, command substitution, alias
  expansion, `&&`/`||` short-circuiting, exit statuses, and command-not-found.
- Every required program has transcripts for its common flags and its common errors, verified
  against the real tool.
- A streaming test: a producer that emits lines over virtual time, piped through `grep`, delivers
  lines as time advances and stops cleanly on interruption.
- `docs/COVERAGE.md` is started with the supported shell syntax and program flags.
