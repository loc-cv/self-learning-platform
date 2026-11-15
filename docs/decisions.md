# Decisions

Decisions that fill gaps in `PLAN.md` or the specs, newest phase last. A decision that
*contradicts* `PLAN.md` is not made here: it is asked first, and then recorded both here and in
`PLAN.md` §15. Each entry: what was decided, why, and what it rules out.

## Phase 00 (2026-11-13)

### Deviations from PLAN.md, confirmed with the owner

**D-001 — The pin is v1.37.2, not 1.37.1.**
`PLAN.md` §4.1 named 1.37.1 as the latest patch. On 2026-11-13 `dl.k8s.io/release/stable-1.37.txt`
and the upstream tag list both showed v1.37.2. §4.1 leaves the exact patch to phase 00, and the
rule "latest patch of the exam's minor" gives 1.37.2. The release binaries the oracle needs
(phase 04) are reachable for 1.37.2. Evidence in `docs/FIDELITY.md` §1.

**D-002 — A check is written as `assert: <name>` plus `with: { … }`.**
The example in `PLAN.md` §8 writes `assert: k8s.podsReady { namespace: "{{ns}}", … }`. That line is
not valid YAML (a plain scalar cannot contain `: `), so the format cannot be implemented as
drawn. The name and the arguments are two keys instead. Same information, parseable, and the
arguments can be validated against the check's schema. `until` steps use the same pair.

### Gaps filled

**D-003 — Variants inside one item.** Steps, checks, hints, named solutions and debrief blocks
may carry `when: { param: value }`. `PLAN.md` §5 asks for "which fault from a family" as a
parameter; this is the smallest mechanism that lets one item hold the family. A solution is a
bare list of steps (as in `PLAN.md` §8) or `{ name, steps, when }`; a debrief is a string or a
list of blocks. There are no expressions and no conditionals inside text.

**D-004 — No build step for packages.** Workspace packages export their TypeScript source
(`exports: ./src/index.ts`). Node (24 or later) runs it by stripping types, Vitest and Vite
compile it themselves, and `tsc -b` only type-checks (declarations go to `.tsbuild/`). Consequences:
relative imports carry the `.ts` extension; `erasableSyntaxOnly` is on, so no enums, namespaces
or parameter properties, which fits "plain functions and data"; tools are run as
`node tools/src/….ts`.

**D-005 — What the determinism guarantee covers.** `simlab/engine-determinism` applies to
`packages/{kernel,host,k8s,learn}/src`, except `*.test.ts`, which may read fixtures from disk.
Beyond `PLAN.md` §12's list (`Date`, `Math.random`, timers) it bans Node and DOM globals, Node
built-in imports, `console`, `fetch`, `crypto`, `Intl`, `performance` and `globalThis`. A second
guard is the type checker: engine sources compile with `lib: ES2024` and `types: []`, so a Node
or DOM API does not even type-check. Not detectable by lint and left to review and determinism
tests: locale-dependent methods (`toLocaleString`), reliance on object key order, and `async`.

**D-006 — The dependency graph as data.** `tools/eslint/boundaries.js` is the one table; the
lint rule and tests read it. Beyond `PLAN.md` §6: `content` may import `kernel` and `learn`;
apps and tools may import any package; no package imports an app or `tools`; apps do not import
each other; imports go through a package's entry point (no deep imports, no relative paths that
leave the package). `learn` is treated as an engine package for determinism, since the scenario
runner and scheduler run in the worker.

**D-007 — TypeScript 6.0.3, not 7.** `typescript-eslint` 8.72.2 supports TypeScript below 6.1.
Revisit when it supports 7.

**D-008 — Cheap fork through containers and frozen values.** World state is mutable containers
holding deeply frozen values; fork copies containers and shares values; the frozen flag is the
marker (`docs/ARCHITECTURE.md` §2.1, §2.7, with the rejected alternatives). This refines
`PLAN.md` §6.1 "world state is plain data" without changing it.

**D-009 — Programs are synchronous generators; actors are event handlers.** Everything
long-lived (controllers, kubelet, units, the TTY line editor) keeps its state in the world and
advances by events. Only what a shell starts is a coroutine, with its frame outside world state.
A fork terminates programs that are not at a restart point in the copy. No `async`, promises or
microtasks in the engine (`docs/ARCHITECTURE.md` §3.4, §5).

**D-010 — Extension contracts live in `kernel`.** Checks, faults, steps and topologies are
registered by plugins and consumed by `learn`, which may import only `kernel`; so their
interfaces are defined there, generically (`docs/ARCHITECTURE.md` §2.11). Their argument schemas
are JSON Schema objects, plain data, so content can be validated at build time and editors can
complete item files. `ajv` and `yaml` are development-time dependencies of `tools` for now;
phase 09 decides where content validation lives.

**D-011 — The `[sim]` notice.** One line on stderr, prefix `[sim] `, exit status 250 reserved
for it. A program the real machine would have but that is not simulated exists in the VFS as a
stub that prints the notice; a program the real machine would not have gets the shell's real
`command not found` and is still logged as a gap (`docs/FIDELITY.md` §4).

**D-012 — What leaves the engine.** Trace, terminal output and gap records go out through
write-only ports and are not world state. The engine keeps no screen and no scrollback. The
trace is never read by engine logic or by checks.

**D-013 — Session start time.** The virtual clock starts at a time given in the session header.
Interactive sessions take the real current time once, in the app, and record it; headless runs
use the item's `startTime` or a fixed default. Replay is unaffected because the value is data.

**D-014 — Curriculum records.** The PDFs are kept in `docs/curriculum/` because the cncf/curriculum
repository licenses them CC-BY 4.0. Competency ids (`cka.troubleshooting.clusters-nodes`) are
assigned in `competencies.yaml`, keeping the two ids `PLAN.md` §8 already uses.

**D-015 — The gate today.** `npm run check` is typecheck, lint and tests. Content validation
joins it in phase 09 with the first items; until then a test validates the worked examples in
`docs/SCENARIO_FORMAT.md` against `docs/schema/`.

**D-016 — Small format decisions.** Checks have `title`, `not`, `within` and `after`; steps have
`until` with a required timeout; a string that is exactly one placeholder takes the parameter's
type; sidecar source hashes are the first 16 hex digits of a SHA-256 over the normalized English
unit (`docs/SCENARIO_FORMAT.md` §4, §6, §7, §12).

## Workstation move (2026-11-15)

**D-017 — Continue on the new workstation as it is.** After phase 00 the owner moved the project
to another machine and asked for the plan, docs and prompts to be adapted to it. It runs Pop!_OS
24.04 (an Ubuntu 24.04 derivative) with Node 26.13.1, bash 5.2.21, GNU coreutils 9.4, systemd 255
and OpenSSL 3.0.13; the full list is in `docs/FIDELITY.md` §2.1.
- Node 26 instead of 24: `engines` already said `>=24`, D-004 works the same on 26, and the gate
  passes with the locked dependencies. `@types/node` stays at 24.19.2 because engine sources
  compile without Node types; move it when a tool or test needs a newer Node API.
- Rank 3 references are this machine's tools, captured in a clean `env -i … bash --noprofile
  --norc` because the agent's shell runs ugrep for `grep` and bfs for `find`. Nothing was captured
  on the previous machine, so no existing reference is affected. Provenance comments name the tool
  version, so a later move only needs a recapture where output differs.
- Formats come from this machine; Ubuntu-server contents (os-release, apt sources and priorities,
  default units) do not, because Pop!_OS changes them.
- Rules out: installing a second Node version to match the old machine, and copying Pop!_OS
  specifics into simulated hosts.

## Phase 01 (2026-11-15)

**D-018 — Kernel choices left open by the specs.** All recorded in `docs/ARCHITECTURE.md` §2.
- The PRNG is xoshiro128**, seeded by SplitMix32 from the hash of (seed, stream name). The hash is
  the cyrb53 core with 64 bits printed, applied as a Merkle hash, so it does not depend on which
  nodes are frozen. The queue is a binary min-heap in an array. At most 100 000 events may run at
  one virtual instant.
- `cancel` removes the event from the heap. The planned `cancelled` map is gone.
- A topic waiter is always "schedule this event". A waiting process is a `host.proc.run` waiter,
  so the kernel needs no process concept and stays domain-agnostic.
- Plugins register input handlers by input kind (`Plugin.inputs`). `Ctx` gains `registry`,
  `during`, `subscribe` and `unsubscribe`. `Kernel` gains `act(label, fn)` for code that runs
  outside events (topology build, steps, faults, tests).
- `Kernel.input` first runs events that are already due. This enforces the ordering rule of §2.5.
  Without it, a session and its replay interleave zero-delay events differently.
- The session header names domain pins as `versions: { kubernetes: … }` instead of a
  `kubernetes` field, because the kernel must not name a domain (CLAUDE.md hard rule 8).
  Checkpoints record how many inputs came before them.
- The interactive driver's arithmetic (speed, fractions, pause, skip) lives in the kernel and is
  tested there. The app supplies only real elapsed time.
- Rules out: a closure or class instance in world state, and any kernel API that names a domain.

**D-019 — Users, groups and the system environment are files.** `Machine` has no `users`,
`groups` or `env` tables. They are the contents of `/etc/passwd`, `/etc/group` and
`/etc/environment`, parsed on demand and cached by inode identity, as glibc's NSS `files`
backend and pam_env read them. With a table beside each file, the two could disagree, and a
learner editing `/etc/group` would see no effect. The kernel hostname, by contrast, is a
machine field, because on Linux it is separate from `/etc/hostname`. This refines the structure
in `docs/ARCHITECTURE.md` §3.1 and does not change `PLAN.md` §6.2.

**D-020 — Simulated hosts are Ubuntu 24.04.5 LTS servers.** That release matches this
workstation's base, so formats captured here (coreutils 9.4, bash 5.2.21, glibc 2.39) are the
simulated host's own. The base system is what the essential packages lay down. Contents are
copied from base-files 13ubuntu10.5, base-passwd 3.6.3build1 and bash 5.2.21-2ubuntu4 as
installed here, and each file was checked against dpkg's recorded checksum. Pop!_OS keeps
Ubuntu's own `os-release`, `lsb-release` and `issue` as `.diverted` files, which matched.
Directory modes come from base-files' postinst. `/var/log` is 0755 root:root because only
rsyslog makes it root:syslog. The login user `student` (uid 1000, in `sudo`) follows adduser and
login.defs.
- Left for later phases: `/etc/shadow` and `/etc/gshadow` (25a, with passwords, `su` and `sudo`);
  `/etc/hosts` (17); `/etc/profile.d/01-locale-fix.sh`, which needs `locale-check` (02, with the
  login environment and locale); packages, their users and units (25b); and `/proc` and `/sys`
  contents (25a).
- Rules out copying Pop!_OS files or its package set into a simulated host.

**D-021 — Rank 3 references are committed with their capture script.** A workstation reference
used in a test lives in `fixtures/reference/<area>/` as the capture script plus its recorded
output. The script's header gives the command and the versions. The first is
`fixtures/reference/linux/vfs-syscalls.{py,txt}`: 90 syscall edge cases run as an unprivileged
user. The VFS test replays each case and must match. Behavior that needs a second user or root
(sticky directories, link protections) cannot be captured this way. Those tests cite man pages
and Linux v6.8 `fs/namei.c`.

## Phase 02 (2026-11-16)

**D-022 — Simulated hosts use the C.UTF-8 locale; a login gets sshd's environment.**
`/etc/default/locale` holds `LANG=C.UTF-8`, which pam_env reads at login. Ubuntu's minimized
cloud images set that default (livecd-rootfs, LP #1759003,
<https://code.launchpad.net/~mwhudson/livecd-rootfs/default-LANG-C.UTF-8/+merge/342144>, read
2026-11-16); an installer-built server may have en_US.UTF-8 instead, so this is a choice, not the
only real configuration. In C.UTF-8, `sort`, `ls` and glob results use code-point order and messages are the
untranslated ones, which keeps every ordering a pure function of the data. Ground truth is
captured with the same locale (`docs/TRANSCRIPTS.md`). A login starts with PATH (sshd's built-in
value, then `/etc/environment`), MAIL, USER, LOGNAME, HOME, SHELL and TERM, as sshd(8) and the
workstation's `/etc/pam.d/sshd` set them; the shell adds PWD, SHLVL and OLDPWD. The umask is 022.
- Rules out en_US.UTF-8, which needs glibc's collation tables to sort like a real host does.
- SSH_* variables arrive with `ssh` in phase 25a.

**D-023 — Process runtime choices.** Recorded in `docs/ARCHITECTURE.md` §3.3–§3.6.
- A run slice is **1000 syscalls**; a process that uses it up is resumed 1 ms later.
- `ProcState` is merged into `Proc`: one frozen record per process holds its descriptors, wait
  state, signal dispositions and restart data. Descriptors change rarely enough that one record
  costs nothing, and one record cannot disagree with another.
- Open file descriptions are a per-machine table (`Machine.files`), so `2>&1` and inherited
  descriptors share an offset as on Linux; an unlinked file lives until its last description closes.
- Coroutine frames live in the runtime, keyed by the world object. A slice may declare `attach`,
  which the kernel calls when it creates a kernel over a world (boot, fork, restore); the host
  ends there every program without a frame that is not at a restart point (§3.4).
- `exec` is real: a process can replace its program, keeping pid, descriptors and process group.
  Pipeline stages run in subshell processes that exec external commands, as bash does.
- Pids start at 1000 on each machine; lower numbers are left for boot-time processes (phase 25a).
- Contents are text: escapes that produce bytes are decoded as UTF-8; other binary data is not
  representable (`docs/FIDELITY.md` DIV-002).
- The output port carries `{ kind: 'tty', tty, data }` with `onlcr` applied.

**D-024 — Transcripts are captured from a real interactive bash on a pty.** The capture runs
`-bash --noprofile --norc --noediting -i` with a PROMPT_COMMAND sentinel, so one session carries
state across commands and every message has the interactive prefix (`-bash: foo: command not
found`), exactly what a learner sees. Format and procedure: `docs/TRANSCRIPTS.md`.
- Rules out capturing with `bash -c` per command, which prints `bash: line 1:` prefixes, loses
  state between commands and lists `ls` output one per line instead of in columns.

**D-025 — Gaps that wait for later phases.**
- Startup files (`/etc/profile`, `~/.profile`, `~/.bashrc`) are not read: they need `if`, `case`
  and `for` (phase 22a). A login shell starts as `bash --noprofile --norc`, so `ll`, `la` and the
  `--color=auto` aliases of Ubuntu's `.bashrc` do not exist yet (STATUS.md, temporary shortcuts).
- The terminal is minimal: canonical input, Ctrl-C and Ctrl-D, `onlcr`. No echo, no line editing,
  no prompt drawing; the shell passes its prompt and phase 03's line editor draws it. (Done in
  phase 03: D-027.)
- `debianutils`' `which` is a `/bin/sh` script; it is simulated as a program (DIV-001), because
  `/bin/sh` is dash, which is not simulated.

## Phase 03 (2026-11-16)

**D-026 — The terminal style of a `[sim]` notice is yellow.** On a terminal each notice line is
written as `ESC[33m` … `ESC[0m` (`styleNotice` in `packages/host/src/proc/notice.ts`); to a pipe
or a file it is plain. Yellow reads on dark and light backgrounds and is not a color the
simulated tools use for errors. Plain transcript sessions strip the style (`unstyleNotices`), so
transcripts keep showing notices as text.
- Rules out dim text (unreadable on some themes) and a style on the `[sim]` prefix alone (easy to
  miss in a long notice).

**D-027 — The line editor is readline's emacs mode, run by the terminal actor.** Specified in
`docs/ARCHITECTURE.md` §3.6 (as built).
- Key bindings are bash 5.2.21's compiled-in defaults without an inputrc, copied from `bind -p`
  (`fixtures/reference/bash/bind-p.txt` → `packages/host/src/tty/bindings.ts`; a test keeps the
  two in step). A bound command the editor implements runs; a bound command it does not prints a
  notice under the line and redraws it; an unbound sequence rings the bell and reads the rest of
  the sequence as new keys, as readline does (`ESC [4~` inserts `~`).
- Ground truth for behavior is a capture of real bash on a pty, key by key
  (`fixtures/reference/bash/readline.{py,json}`, 38 cases). The test compares screens and cursor
  positions after every key, not bytes: readline's choice of cursor sequences is not reproduced.
- Completion is split as in bash: readline's half (word boundaries, quoting, common prefix,
  double Tab, `Display all N possibilities?`, `--More--`) is `tty/complete.ts` and `tty/editor.ts`;
  bash's half (what the word can become) is a `completion` contribution (`shell/complete.ts`,
  named in the shell's edit request with the variable and alias names it needs). A program
  completes its own arguments with `ProgramSpec.complete`, the stand-in for a bash-completion
  function; builtins `cd` and `pushd` complete directories as bash-completion 2.11 does.
- The kill ring, last search string and line editor state are world data on the `Tty`; a shell
  at its prompt with a half-typed line stays quiescent and survives snapshot and restore.
- Bracketed paste is not enabled (DIV-012).

**D-028 — Two kinds of headless session.** A plain session (transcripts, most unit tests) is set
up as the transcript capture sets up real bash: `-bash --noediting`, echo off, `PS1=; PS2=` typed
first. A terminal session (key-level tests, `npm run sim`) is a learner's terminal: line editing,
echo, the real prompt. Both wait until the shell itself waits for terminal input again (at PS1
or PS2), answering editor requests on the way.

**D-029 — The editor protocol as built.** `ProcApi.openEditor` yields an `edit` syscall; the host
records an editor session (`HostSlice.editors`), sends `{ kind: 'editor.open', session, tty,
request }` through the output port and blocks the program until `editor.close`. Each
`editor.save` writes the file with the program's credentials, working directory and umask, in
place (owner and mode kept), and answers `{ kind: 'editor.status', ok, message }`; the failure
message is vim's `"NAME" E212: Can't open file for writing`. The request carries `flavor`
(`vim` or `nano`), `path`, `name` (as typed), `content`, `readOnly` and a `language` hint.
`kubectl edit` (phase 08) reuses it on a temporary file. The terminal player answers with the
user's `$VISUAL`, `$EDITOR` or `vi` on a temporary copy (saved only if the file changed);
headless runs answer with supplied content.
- The packages `vim`, `vim-tiny`, `nano` and `sensible-utils` joined the base system with the
  alternatives their maintainer scripts set (`editor` → nano, `vi`/`vim`/`view` → vim.basic),
  from the Ubuntu 24.04 cloud image manifest's versions (`tools/src/base/capture_binaries.py`).

**D-030 — Command-line tools.** `npm run play` and `npm run sim` live in `apps/cli`.
- The player is a core (`player.ts`: world, interactive driver, recorder, editor answers; tested
  with a fake clock) and a terminal layer (`play.ts`: raw mode, resize, `Ctrl-]` to leave, gap
  records appended to `data/gaps.jsonl`). Sessions are recorded by default to
  `data/play/<time>-<topology>-seed<N>.json`; `--replay` checks the final world hash.
- Script mode types each line and runs virtual time until the shell waits for input again; `@`
  directives advance time, type raw keys, resize, and supply editor content. It prints the screen
  (a small terminal model with scrollback, `tty/screen.ts`), the raw bytes, or transcript format.
- The first topology is `ubuntu-1`: one Ubuntu machine `node01` with the user `student`, registered
  by the host plugin under the kernel's `topology` kind.

**D-031 — The prompt before startup files are read.** A login shell sets PS1 to what Ubuntu's
`~/.bashrc` would leave when `~/.profile` and `~/.bashrc` are the files the system installed
(the colored `\u@\h:\w\$ ` with the xterm title for a user on an `*-256color` terminal, plain
for root), and bash's default otherwise. A temporary shortcut until phase 22a runs the files.
