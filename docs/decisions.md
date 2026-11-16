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

**D-032 — The simulated server's `awk` is gawk.** Decided with the owner on 2026-11-16, after
phase 03. The Ubuntu 24.04 server cloud image manifest lists `gawk 1:5.2.1-2ubuntu0.1` next to
mawk, and gawk's postinst registers the `awk` alternative (with `nawk`) at priority 10 against
mawk's 5, so `awk` runs gawk there. The base system follows the cloud image for its package set and
versions (D-029) and for its locale (D-022); exam nodes are cloud VMs; and the workstation's
`awk` is the same gawk 5.2.1, so captures need no special handling. `capture_binaries.py` includes
gawk, and the alternatives come out as `awk`, `nawk` → `/usr/bin/gawk`; mawk stays as
`/usr/bin/mawk`.
- Rules out mawk as `awk`, which an installer-built server may have (not verified) but which
  would make `awk` the one thing not taken from the cloud image.
- gawk-only features (`gensub`, `strftime`, …) fail on a host whose `awk` is mawk; phase 22b
  registers that as a divergence note for learners.

## Phase 04 (2026-11-16)

**D-033 — The `kubeadm-1cp-2w` cluster's values are fixed in `tools/src/oracle/topology.ts`.**
The oracle needs Node objects before phase 06a builds the topology, so their values are chosen
here and phase 06a builds the simulated topology to match: controlplane 172.16.0.10, node01
172.16.0.11, node02 172.16.0.12; Pod CIDRs 10.244.{0,1,2}.0/24 out of 10.244.0.0/16; services
10.96.0.0/12 (kubeadm's default, `kubernetes` at 10.96.0.1); API server on 6443; 2 CPUs, 4 GiB
and a 20 GiB disk per node, allocatable reduced by the kubelet's default hard eviction
thresholds; Ubuntu 24.04.3 LTS, kernel 6.8.0-88-generic, containerd 1.7.28, kubelet v1.37.2.
Labels, the attach-detach annotation and the control-plane taint follow the kubelet's and
kubeadm's code (cited in the file). The values are the topology's choice, not a reference: phase
06a may change them, and then recaptures every fixture (`npm run golden:capture`).
- Rules out a simulated cluster whose addresses differ from the fixtures', which would make every
  differential comparison need another mapping.

**D-034 — Tokens are `<<kind>>` and `<<kind:N>>`, shared by fixtures and transcripts.**
kubectl prints `<none>`, `<invalid>`, `<unset>` and `<pending>`, so single angle brackets cannot
mark a placeholder, and `{{…}}` is the content format's parameter syntax. A lowercase kind name
between `<<` and `>>` is not something kubectl prints (a here-document's `<<EOF` in `cat` output has
no closing `>>`). The vocabulary lives in
`packages/host/src/transcript/tokens.ts` (domain-agnostic: UIDs, times, addresses, ports,
generated names); `uid` and `hash` are numbered so that "this owner reference is that object" stays
visible, and every other kind is not, because numbering rows that a hidden suffix orders would
make fixtures change between captures. A transcript's expected output may contain tokens; a
token matches any value of its kind (`docs/TRANSCRIPTS.md`).

**D-035 — Normalized tables are re-aligned with kubectl's own tab writer.** A token is not as wide
as the value it replaces, and kubectl's column widths depend on every value in the column, so a
fixture whose ages went from 9s to 10s would otherwise change. Normalization splits a table back
into cells, replaces values per cell and renders the cells again with a port of the tab writer
(`tools/src/golden/tabwriter.ts`). The split is checked: if rendering the captured cells does not
reproduce the captured text exactly, capture fails rather than guessing. Rows of a `get` table
holding a generated-name token are sorted by their normalized text, since their real order
depended on the hidden suffix. Phase 07a normalizes simulator output with the same function before
comparing.
- Rules out comparing tables with collapsed whitespace, which would stop the fixtures from
  verifying layout at all.

**D-036 — KWOK plays the kubelets, with its own stages trimmed.** Without heartbeats the node
lifecycle controller marks the fake Nodes NotReady and taints them within a minute, and without a
kubelet no Pod ever runs. KWOK v0.8.0 renews Node leases and moves Pods to Running. Its
`stage-fast` configuration is copied to `tools/src/oracle/kwok-stages.yaml` with two changes, so
that it keeps the Node as registered: `nodeInfo` and `daemonEndpoints` are not filled with
`kwok-v0.8.0` placeholders, and no Node `phase` is invented. One stage is added: Pods annotated
`simlab.dev/kwok-not-ready: "true"` run without becoming ready, for cases that need not-ready
endpoints or a stuck rollout. What KWOK writes is never treated as
kubelet output: fixtures list it under `kwokAuthored`, and steps and objects that show it carry
`kwok: true` (`docs/FIDELITY.md` §6.5).

**D-037 — Scheduling ties are a token, not a pinned node.** With two identical workers the
scheduler's choice among equal scores varies between runs: it filters nodes in parallel goroutines
and appends each feasible node when its goroutine finishes, and the score heap then breaks ties by
that order (upstream: `pkg/scheduler/schedule_one.go` findNodesThatPassFilters,
`framework/sorted_nodes.go`; corrected in phase 06a, which found no `selectHost` in v1.37). A case that needs `kubectl run` as typed, without a node selector, marks the steps
whose output shows the placement `anyWorker: true`: `node01`/`node02` become `<<node>>` and their
addresses `<<ip>>`. Cases where the node matters pin it with a node selector or `nodeName`.

## Phase 05a (2026-11-16)

**D-038 — The schema is vendored from OpenAPI v3 and the Go types; descriptions wait for explain.**
The OpenAPI documents describe structure but not what encoding/json does with it: whether a
field has `omitempty` or `omitzero`, whether it is a pointer, a nil slice that prints `null`, a
non-pointer `metav1.Time` that prints `null`, the Go type names that type errors print
(`v1.RestartPolicy`, `[]v1.Container`). `npm run api:vendor` therefore reads the Go declarations
of the API packages too (a small reader of gofmt'ed struct declarations, `tools/src/openapi/gotypes.ts`)
and fails when they and the OpenAPI properties disagree. Format and measurements:
`docs/ARCHITECTURE.md` §4.6. Descriptions (739 KiB) have no consumer until `kubectl explain`, so
they are generated only with `--descriptions`; the explain phase turns that on. (Phase 08 found the checked-in v3 spec lacks enums and captures explain's documents from the real server instead: D-082; `--descriptions` is gone.)
- Rules out guessing Go encoding from OpenAPI `default` values, which mark some non-omitempty
  fields but not nil slices (`EndpointSlice.endpoints: null`) or non-pointer times
  (`lastProbeTime: null`).

**D-039 — NamespaceLifecycle admission exists before the admission phase.** Phase 20b owns the
admission chain, but without NamespaceLifecycle the simulated server would accept objects into a
namespace that does not exist, or one being deleted, which learners hit constantly and which no
real server does (hard rule 2). It is ported now (`apiserver/admission.ts`, from
`apiserver/pkg/admission/plugin/namespace/lifecycle`), including the immortal namespaces. The other
default plugins (ServiceAccount, DefaultTolerationSeconds, Priority, …) stay in 20b; until then
Pods lack what they add (STATUS.md, temporary shortcuts).

**D-040 — Where Go iterates a map, the port iterates in key order.** Validation of labels,
annotations and data keys, the order of a Namespace's GC finalizers, and LabelSelectorAsSelector
iterate Go maps, whose order is random: the real server's message order varies between requests.
Sorted key order is one of the orders the real server produces, so it is not a divergence, and it
keeps the simulator deterministic.

**D-041 — Raw API golden cases, and the registry generated from the oracle's discovery.** The
golden case format gains a `request` step: one HTTP request to the oracle's API server as the
admin identity, recording the status code, warnings and normalized body. This is what the request
pipeline must reproduce (kubectl output depends on kubectl too). Cases in
`fixtures/golden/cases/api/` (discovery, crud, lifecycle, validation, defaults);
`tools/src/golden/api.test.ts` replays every request step through the simulator. The resource
registry (every resource the real server serves, with verbs, short names and categories) is
generated from the captured discovery documents rather than from upstream source: it is exactly
what a kubeadm-started v1.37.2 server serves, alpha APIs excluded.

**D-042 — Request bodies are JSON values.** The simulator's clients (kubectl, controllers) hand
the pipeline parsed values, so malformed JSON and duplicate keys cannot reach it: real kubectl
rejects both while parsing its input. The differential runner skips the fixture steps that send
such bodies. A number arrives as a JavaScript number, so a quantity written `1e3` in JSON is
canonicalized as `1k`; kubectl converts YAML to JSON with float64 numbers, which loses the
spelling the same way.

**D-043 — Kinds without a strategy answer with a gap.** The registry lists every served
resource, but only kinds with a ported strategy (defaults, validation, registry rules) store
objects. A request for any other kind returns `notSimulated`, which clients print as a `[sim]`
notice, rather than storing objects that were never validated. Unported validation of a field
that a request uses calls `StrategyCtx.notPorted`, which writes the gap log.

**D-044 — Two APIs can share one storage resource.** core/v1 and events.k8s.io/v1 Events are the
same objects in etcd (`/registry/events`), stored as core/v1. A strategy names its `storage`
resource and its storage version and group (`storageVersion`, `storageGroup`); the pipeline
converts with the strategy's `toStorage`/`fromStorage` (a port of `pkg/apis/events/v1`
conversion) whenever the request's group version is not the storage's, for writes, reads and
watch events. So an Event a kubelet records through events.k8s.io shows up in
`kubectl get events`, as it does in reality.

**D-045 — The scale subresource is read-only until kubectl scale needs it.** GET of
`deployments/scale` and `replicasets/scale` answers with the autoscaling/v1 Scale. Writing it has
to apply the Scale to `spec.replicas` through the main strategy and answer with a Scale; until the
phase with `kubectl scale` builds that, a write is a gap rather than a wrong answer. (Done in phase 08: D-092.)

**D-046 — Differential tests strip what admission plugins of phase 20b add, field by field.**
Rather than listing whole steps as known differences, `tools/src/golden/api.test.ts` and
`defaulted.test.ts` remove the fields the ServiceAccount, DefaultTolerationSeconds and Priority
plugins write from both sides of Pod responses, so that every other field (graceful deletion,
generation, defaults) is still compared with the real server. Phase 20b deletes the stripping.

**D-047 — Controllers read the store and model their reaction time.** A controller's informer
cache is the store itself (`Reader` in `packages/k8s/src/controllers/types.ts`), so bookkeeping
that only hides informer lag (ReplicaSet and Deployment expectations) is left out: with no lag it
never changes what a controller does. A MODIFIED watch event carries the previous object, which
informer update handlers receive. Writes go through the pipeline as the controller's service
account. Every controller reacts 5 ms after the watch event that queued a key, unless upstream
adds a delay of its own for a path; the figure is a model (informer delivery plus queue pickup),
since the oracle's second-precision timestamps cannot measure it, and nothing observable depends
on its exact value: rollout pacing comes from the kubelets. Retries use client-go's default
per-item backoff, 5 ms · 2^n capped at 1000 s; its overall 10 qps bucket is left out. Details in
`docs/ARCHITECTURE.md` §4.3.

**D-048 — `pods/binding` is served from phase 05b.** The scheduler of phase 06a binds through it,
and the controller tests need bound Pods now, because only a bound Pod is deleted gracefully
(an unbound one disappears at once), which decides `terminatingReplicas` and what a rollout
sees. The subresource is a port of `BindingREST.Create` for valid bindings without
preconditions; an invalid Binding and Binding preconditions answer with a gap until a client
sends them.

**D-049 — The event recorder keeps client-go's correlator state in world data.** Each
controller's recorder state (the de-duplication log, the aggregation records, the spam filter's
token buckets) lives in the k8s slice per controller, so `count`, `(combined from similar
events)` and spam filtering survive snapshots and replay. Where Go is random or concurrent the
simulator fixes a choice: `PopAny` takes the oldest key, the broadcaster writes within the sync
that recorded the event, and event names use the virtual clock in nanoseconds, counted up within
a millisecond so two events about one object never collide (a real nanosecond clock never does).

**D-050 — `namespaces/finalize` is served, through per-subresource update strategies.** The
namespace controller removes the `kubernetes` finalizer with it, as upstream does. A strategy
can declare update subresources with their own `StatusStrategy`-shaped rules
(`Strategy.updateSubresources`); the pipeline uses that strategy for PrepareForUpdate,
ValidateUpdate and warnings, the way it uses `status`. The Namespace's `finalize` is a port of
`namespaceFinalizeStrategy` (status kept, spec and metadata as sent,
`ValidateNamespaceFinalizeUpdate`). Discovery gives it only `update`, so a patch is a 405 as on
the real server. The API server serves no `deletecollection` verb yet; the namespace deleter uses
upstream's own fallback for resources without it (list, then delete each item).

**D-051 — The runtime carries what some controllers' queues need beyond the default.** A
controller may name its own per-key backoff (`ControllerSpec.backoff`; the endpointslice
controller's Service queue starts at 1 s), and start-up list events are marked `initial`
(the endpoints controller's `checkLeftoverEndpoints` acts on the first sync only). State that
upstream keeps in a handler-side tracker (the EndpointSlice tracker) lives in the controller's
`data`, which only a sync can read, so slice events become their own queue keys
(`slice-sync:…`, `slice-deleted:…`) whose sync does what upstream's handler does. They show up
in the trace as syncs.

**D-052 — Ownership patches are JSON merge patches with the same result.** Upstream adopts and
releases (ControllerRefManager) and the garbage collector removes owner references with
strategic merge patches, which the pipeline did not accept until phase 07b (switching the
controllers to them is carry-over in STATUS.md). Controllers send JSON merge
patches carrying the whole resulting `ownerReferences` (and `finalizers`) list, with `uid` or
`resourceVersion` preconditions as upstream's patches have; `ownerReferences: null` when none
remain, so the key disappears as the golden fixture shows. The stored objects are identical; the
requests differ only in their patch type.

**D-053 — The pod-template-hash is computed exactly, from vendored Go struct layouts.**
`controller.ComputeHash` hashes go-spew's printing of the Go `PodTemplateSpec`, which shows
every field, Go field names, nil versus empty, and unexported internals. `npm run api:vendor`
also writes `packages/k8s/src/openapi/data/v1.37.2.golayout.ts` (the struct layouts reachable
from `PodTemplateSpec`), and `packages/k8s/src/controllers/hash/` turns stored JSON into the Go
value the controller holds after protobuf decoding and prints it with spew's rules. Checked
against 28 templates hashed by the real control plane (`podtemplate.fixture.json`). So ReplicaSet
and Pod names equal the real cluster's for the same template. The hash of a template with
timestamps depends on the controller manager's time zone; the simulator models UTC, Go's
fallback when the container has no `/etc/localtime` (expected for kubeadm's static Pod image, not
verified on a running cluster).

**D-054 — The events.k8s.io broadcaster's periodic work runs on an exact grid, and only while a
series exists.** client-go's `tools/events` broadcaster runs `finishSeries` every 6 minutes and
`refreshExistingEventSeries` every 30 minutes with `wait.UntilWithContext` from
`StartRecordingToSinkWithContext`, on goroutines whose periods drift by the time each run takes.
`packages/k8s/src/controllers/events.ts` keeps the cache in the k8s slice per component and puts
the ticks exactly on the grid from the broadcaster's start (`startEventsBroadcaster`, or its first
event). A kernel event is pending only while a cached event has a series; dropping single events
from the cache, the only other thing a tick does, is applied lazily as of the latest tick
whenever the broadcaster next acts, which gives the same result. A tick goes before an event
recorded at the same instant; where both loops tick, `finishSeries` goes first (a finished series
is then not also refreshed). Cache keys are visited in code-unit order (Go: random map order).
The series patch is a JSON merge patch with the same result as upstream's strategic merge patch
(D-052). The broadcaster writes at the instant an event is recorded; its retries (transport
errors, AlreadyExists after a series' fallback create) cannot occur without a transport and are
left out. A stopped broadcaster drops events until started again and keeps its event-name clock,
so a restart at the same virtual instant still names events uniquely.

## Phase 06a (2026-11-16)

**D-055 — Topologies are data: a ClusterDef and one builder.** `packages/k8s/src/topology/`
defines a cluster as a `ClusterDef` (machines with their role, address, Pod CIDR and machine IDs;
network ranges; whether the control-plane taint was removed; the entry) and builds every one with
`buildCluster`. Two are registered: `kubeadm-1cp-2w` and `kubeadm-1n`, a single untainted node, as
the kubeadm guide's "control plane node isolation" step leaves a one-machine cluster. The values
D-033 fixed for the oracle now live in the engine; `tools/src/oracle/topology.ts` imports them.
- The terminal opens as root on `controlplane`, where kubeadm's closing instructions put the
  admin kubeconfig (`/root/.kube/config`). Every node also has the user `ubuntu`, the default
  account of Ubuntu's cloud images.
- `PLAN.md` §7 lists a student workstation in `kubeadm-1cp-2w`. It is not built yet: nothing can
  use it before `ssh` (phase 25a) or clients outside the cluster (phase 19a), and a machine nobody
  reaches only slows forks. The first of those phases adds it; content can then set
  `entry: { machine: workstation, … }` as `docs/SCENARIO_FORMAT.md` §5 shows.
- No topology parameters yet (`params` is the empty schema); the first one comes with the first
  item that needs a variant (e.g. `networkPolicy`, phase 19a/29a).

**D-056 — kube-scheduler runs on the controller runtime with upstream's queue semantics.**
`packages/k8s/src/scheduler/`: the runtime's queue is the active queue (5 ms latency, as D-047).
A failed Pod is held as unschedulable with the plugins that rejected it and is requeued only when
one of their queueing hints (EventsToRegister) says Queue for a watched Node or Pod event, when its
own update matters, or by the leftover flush (30 s grid, after 5 minutes). SchedulerPopFromBackoffQ
is on in v1.37, so a requeued Pod is retried at once while nothing else waits; the 1–10 s backoff
applies only when other Pods are queued. Filters, their order, reason strings, status codes and the
FitError and preemption messages are ported exactly; the default profile's other filters (volumes,
DRA, topology spread, inter-Pod affinity, declared features) pass for the simulated Pods.
Scoring ports TaintToleration, NodeAffinity, NodeResourcesFit (LeastAllocated), BalancedAllocation
and ImageLocality with upstream's integer arithmetic; PodTopologySpread (its system default
constraints) and InterPodAffinity are phase 20b, so placement among workers can differ from a real
cluster's when those would break a tie. Ties: the order of feasible nodes is drawn from the PRNG
stream `k8s.scheduler.filter-order` (D-037), and the score heap is replayed as Go's container/heap.
Preemption itself is phase 20b; with no PriorityClasses every Pod has priority 0 and has no victims,
which is what the messages say. The scheduler writes its events through the events.k8s.io recorder
(D-054) as `default-scheduler`/`default-scheduler-<host>`, binds with the Pod's uid as a
precondition (which `pods/binding` now checks), and writes PodScheduled=False only when it changed.
The node lifecycle controller's NoSchedule tainting pass exists because cordoning goes through it:
its latency (20 ms) keeps the order the golden capture shows, where the scheduler retries an
uncordoned node before the `node.kubernetes.io/unschedulable` taint is gone.

**D-057 — The cluster is what the real kubeadm writes, captured, minus what has no model yet.**
`npm run kubeadm:capture` runs the real kubeadm v1.37.2 `init --dry-run` unprivileged (a user and
UTS namespace, `KUBEADM_INIT_DRYRUN_DIR`) and generates `packages/k8s/src/topology/kubeadm/
reference.ts`: static Pod manifests (text and objects), kubeconfigs, kubelet files and the 28 API
objects. The topology writes the files and creates the objects through the API server.
Left out until their phases: certificate data (kubeconfig `*-data` lines, `cluster-info`'s CA,
`/etc/kubernetes/pki`; 25b, 28) and RBAC objects (20a). A joined worker's kubelet.conf follows the
kubelet's bootstrap code (rank 2). The control plane's mirror Pods are built from the manifests
the way the kubelet does (name suffix, config annotations, Node owner, the NoExecute toleration)
and kube-proxy's Pods the way the DaemonSet controller does, both seeded as running; their
`kubernetes.io/config.hash` is an FNV-128a of the manifest, not of the Go struct dump (DIV-019).
CoreDNS is created by the controllers and bound by the scheduler, and stays Pending until the
kubelet (06b). There is no CNI agent, so Nodes have no NetworkUnavailable condition; phase 29a
installs the modeled plugins.

## Phase 06b (2026-11-16)

**D-058 — The kubelet is a controller-runtime instance per node with suspended pod workers.**
`packages/k8s/src/kubelet/`: instance = node name, identity `system:node:<node>`, keys
`<namespace>/<name>/<uid>`. A Pod key syncs as upstream's pod worker: status first, then
computePodActions, the sandbox before any pull, containers in spec order. A CRI call that takes
time (RunPodSandbox, PullImage through the serial puller, CreateContainer, StartContainer,
StopContainer) suspends the SyncPod in the worker's data (`PodOp`) and the key comes back when it
returns; any other trigger meanwhile sets the pending flag, which re-syncs right after, as
pod_workers.go does. Sync triggers are upstream's: watch events that change spec, labels,
annotations or deletion fields (status-only updates are reconciles, `podsDifferSemantically`),
PLEG events on the 1 s relist grid from the kubelet's start, the on-demand relist after a sync
that did something, and completeWork's requeues (10 s · Jitter 0.5 after an error, the back-off
expiry clamped to 1 min). The reason cache makes ErrImagePull, ImagePullBackOff and
CrashLoopBackOff reach the API one sync after their event, which is why they alternate in
`kubectl get pods -w`. Modeled choices: the one-minute success resync is not scheduled (it changes
nothing, and would keep `settle` from ever being quiet); status writes are a read and an update of
`/status` with the same result as the strategic merge patch; containers of a Pod are stopped in
spec order (upstream: parallel goroutines); a deleted Pod's containers, sandboxes and log
directory go at the next one-minute container GC tick.

**D-059 — The container runtime is node-owned world data, not part of the kubelet.**
`k8sSlice.runtimes[node]` (slice version 4): the image store, sandboxes, containers and their
processes. Containers keep running, exiting and logging while the kubelet is stopped; a started
kubelet adopts them (restart counts survive, back-offs do not). Pod IPs come from host-local IPAM
in the node's Pod CIDR (the next free address after the last one handed out, .1 excluded), since
the clusters have no CNI agent yet (phase 29a). Logs are CRI-format files under `/var/log/pods`
with `/var/log/containers` symlinks, written as output happens (`F` lines, a `P` remainder when
the stream closes); sub-millisecond digits of their timestamps come from the stream
`k8s.runtime.log-time`. Container ids are 64 hex digits from `k8s.runtime.id`.

**D-060 — Behavior models are pure step machines, contributed per program, in `packages/host`.**
`packages/host/src/models/types.ts` (registry kind `host.behavior-model`): `start`, `resume` and
`signal` return output with offsets, the next wake-up, a wait, an exit or an exec. This refines
docs/ARCHITECTURE.md §3.9's `evaluate` sketch: a model's state is resumable data, so loops and
sleeps cost one event per wake-up. Models are per program, not per image: an image's file table
(captured) says which executables exist and which model each runs, so `command: ["sleep", "1d"]`
on any image, a missing executable and BusyBox applets behave naturally. The host owns the
contract because systemd units (phase 25a) and later domains use it; the Kubernetes runtime
drives it. PID 1 without a handler ignores a default-action signal, so `sleep` and `sh` as a
container's command wait out the grace period and die by SIGKILL (137), as on a real node. The
declarative form of `docs/SCENARIO_FORMAT.md` §5.4 compiles into such a model when phase 09 adds
content images.

**D-061 — Images come from a catalog captured from the real registries.** `npm run images:capture`
(`tools/src/images/`) records, for a fixed list of tags, the repo digest, the linux/amd64
manifest, the config (the image ID; Entrypoint, Cmd, Env, StopSignal) and layer sizes; the full tag
list of each captured repository; Docker Hub's official image names; and the executables of one
image per family, read from the layers (others borrow their family's table, `filesFrom`). A pull
fails with containerd's real error only when the simulator knows the image does not exist (a tag
missing from the repository's list, an official-looking name outside the official set, a domain
reserved by RFC 2606/6761); anything else it cannot answer for fails with a `[sim]` message and a
gap rather than an invented error (DIV-025). The DNS failure's `on 127.0.0.53:53` assumes Go's own
resolver on the node, which `/etc/nsswitch.conf` `hosts: files dns` on the Ubuntu server image
selects; not verified on a real cloud image (containerd-notes in the phase handoff).

**D-062 — The kubelet's node side.** Lease renewal every 10–10.4 s and node status every
10–10.4 s run as idle kernel events (`k8s.kubelet.heartbeat`), so a healthy cluster lets `settle`
return. Status is patched only on change or after 5 min plus a delay drawn from
`k8s.kubelet.report-delay` in [−2.5 min, 2.5 min); the image list is refreshed every 30 s. Start
events are Starting, the three pressure events and NodeAllocatableEnforced; the commonly seen
`InvalidDiskCapacity` is a race between image GC and cAdvisor and is left out.

**D-063 — Node health monitoring without NoExecute.** The node lifecycle controller tracks each
node's probe timestamp from Lease renewals and Ready heartbeats; the deadline (first 5 s tick after
50 s) is an idle kernel event that each renewal moves, so nothing polls. On expiry: Unknown
conditions, NodeNotReady, MarkPodsNotReady and, through the NoSchedule pass, the unreachable
taint; RegisteredNode for every node at start. NoExecute taints and taint-based eviction come with
DefaultTolerationSeconds in phase 20b (DIV-026).

**D-064 — The topology seeds running containers, not running statuses.** The control plane's
mirror Pods and kube-proxy's Pods get sandboxes and running containers in their node's runtime at
build time (`kubelet/seed.ts`), and the images kubeadm pulled are in the stores (all of kubeadm's
on the control plane, including its `pause:3.10.2`; kube-proxy's and containerd's sandbox image
`pause:3.8` everywhere). The kubelets then write those Pods' statuses as a restarted kubelet would.
CoreDNS is pulled and started by the worker kubelets about two seconds after the build.

**D-065 — Step latencies are one tunable table.** `kubelet/latency.ts`: sandbox creation, registry
resolution, download bandwidth and unpack rate (so pull time follows the image's size), container
create and start, sandbox stop — uniform draws, each step from its own stream
`k8s.kubelet.latency.<step>`. They are the simulator's figures for a small cloud VM, not
measurements; upstream's own constants (relist, back-offs, resyncs, grace periods) are not in the
table.

## Phase 07a (2026-11-16)

**D-066 — A category lists only types the simulator stores.** `kubectl get all` expands to every
member of the `all` category, as discovery announces it (cronjobs, jobs, statefulsets, HPAs…).
The API server answers `notSimulated` for a resource it does not store; a visit that came only
from a category treats that as an empty list, because no object of such a type can exist in the
simulator, so the printed result is the real one. A type named explicitly (`kubectl get
cronjobs`) prints the `[sim]` notice, since the learner asked about something not simulated.

**D-067 — kubectl is one dispatcher over the real command manifest.** The command tree, aliases,
flags and help come from the real binary (`kubectl/data/`, `npm run golden:kubectl-manifest`).
cobra's Find and pflag's parser run over it, so unknown commands and flags fail with kubectl's
errors before anything else, and the simulator's gaps are exactly the manifest's commands without
a `Verb` and the flags a verb does not declare, each a `[sim]` notice. Flags with no observable
effect in a simulated world are accepted only from a list that gives each one's reason.

**D-068 — The connection is resolved by address, the server listens on its machine.** Until the
network model (phase 17), a client resolves its server URL's host to a machine by
`Machine.addresses` (written by the topology from `ClusterDef` node IPs; loopback is the local
machine), and an API server in `k8sSlice.apiServers` listens on every address of the machine its
advertise address belongs to (kube-apiserver binds 0.0.0.0) at its secure port. A known machine
with nothing on the port refuses, which is what a learner sees when the API server is down; a
host that no machine has, a machine that is off and plain HTTP to the TLS port are notices rather
than invented timeouts. `localhost` dials as `[::1]`, as the workstation's capture shows
(docs/FIDELITY.md §6.9).

**D-069 — kubeconfig credentials are not read yet.** kubeadm's kubeconfigs have no certificate
data (D-057) and the API server authenticates nobody (phase 20a), so a user entry stands for the
certificate it would hold and every request is admitted. A real kubectl given such an empty user
on https would prompt for a username and password; the simulated one does not. Phases 20a and
25b replace this with real identities from the certificates.

**D-070 — Help is rendered from the manifest, proved against the binary.** Storing every
command's raw help would add about 260 KB to the engine. The manifest keeps only what the other
fields cannot give (description, examples, the root's groups); Options, Usage, Aliases, command
lists and hints are rendered with ported templates, wrapped on a terminal with a port of
go-wordwrap as kubectl's term writer does it (per template write; flag usages at the stdout limit
minus 10; nothing below 80 columns). `npm run golden:kubectl-manifest` compares the rendering of all
111 commands with the binary, piped and at four widths; the gate compares the captured help
fixtures. `help` and `options` are manifest commands marked `unlisted`. The "Subcommands provided
by plugins:" group is always empty: plugins on a machine's PATH are not modeled.

**D-071 — Tables are made by the API server.** As in the real system, `kubectl get` asks for
`as=Table` and the API server converts with the ported printers (`packages/k8s/src/printers/`,
pkg/printers/internalversion), reading the stored object rather than Go's internal type
(events.k8s.io Events print through the core Event printer, as their shared storage does upstream).
`as` and `includeObject` are honored on get, list and watch only; a watch sends column
definitions with its first event only. kubectl's human-readable printer and liggitt's tab writer
(`packages/k8s/src/kubectl/printers/`) keep their state as plain data, so a watch's remembered
widths and header state could live in a process record. Column descriptions are copied verbatim
from the swagger docs at the pin.

**D-072 — The differential runner replays every case and shims the verbs not built yet.** Each
golden case runs in an oracle-like simulated world (kube-system workloads removed). Steps the
simulated kubectl implements are compared after capture's normalization; state-changing steps
of other verbs go through a shim that sends what real kubectl sends, so later comparisons see the
same cluster. KWOK-authored and admission-plugin fields are masked on both sides rather than
listed as differences, numbered tokens are renumbered per step (a skipped step must not shift
later numbering; consistency across steps is no longer checked), and every accepted difference
is a KNOWN entry with its cause that fails the test once it passes. The shim shrinks as phases
07b, 08 and 15 build the verbs.

## Phase 07b (2026-11-16)

**D-073 — Strategic merge patch is a direct port over the Go struct tags.**
`apimachinery/strategicpatch/` ports patch.go function by function: apply (merge keys, `$patch`,
`$retainKeys`, `$deleteFromPrimitiveList`, `$setElementOrder`), the two- and three-way diffs and
their conflict checks. Patch strategies and merge keys come from the vendored Go types' struct
tags (`PatchMetaFromStruct`); kubectl apply looks them up in OpenAPI v3, which gives the same
strategies (DIV-034). Upstream merges in place and the server's errors print the mutated patch,
so the port mutates copies the same way, and models Go's slice aliasing where it decides the
result (lists decoded from JSON grow as `append` grows them; a stored list has capacity equal to
its length, as the generated deep copy allocates it). Sorting by merge key uses Go's insertion
sort up to 12 items and a stable sort beyond, as `sort.SliceStable` does with upstream's
comparison. The server path (smpPatcher) applies the patch to the current object, converts with
a port of the unstructured converter (`apimachinery/converter.ts`, whose type errors differ from
encoding/json's), then decodes, defaults and updates as for a JSON merge patch; merge errors map
to 400, 422 or reason-less 500 as the oracle answers (`fixtures/golden/v1.37.2/api/strategic-patch.yaml`).
upstream's patch_test.go tables are copied verbatim by `tools/src/strategicpatch/extract-tests.ts`
and all run.

**D-074 — `-f` reads every file and all of standard input before the first request.**
`kubectl/resource/files.ts` expands paths (files, directories by extension, `-R`, globs with a
port of Go's filepath.Glob, `-`), splits and decodes every document, and maps each kind, then
the command visits the items in order, so errors keep upstream's order (the command's own
errors, then the read errors as one aggregate, as ContinueOnError gives them). The only visible
difference is interactive standard input, which real kubectl processes document by document
(DIV-035). A URL prints the notice before any file is visited. kubectl's client-side OpenAPI v2
validation, which upstream applies only to what the server cannot validate (items of a `v1 List`,
create-only kinds), is not ported: a document passes when the schema decode finds no unknown
field, type error or missing required field, and prints a notice otherwise.

**D-075 — create and apply: flags that act only with another flag are on the no-effect list.**
`--grace-period`, `--timeout`, `--wait` (apply, only with `--force` or `--prune`),
`--windows-line-endings` (create, only with `--edit`), `--show-managed-fields` and
`--allow-missing-template-keys` (no managedFields, DIV-015; template formats print a notice) have
no effect unless a flag that itself prints a notice is given. `--openapi-patch=false` only drops
the two warnings of a failed patch (golden-verified). The last-applied annotation is
GetModifiedConfiguration's exact serialization (`kubectl/util/apply.ts`).

**D-076 — describe renders everything before writing.** A describer's output is built completely
first, so a notice (a volume source or kind not simulated, a TZ other than UTC: machines run in
UTC and kubectl prints local times) never follows partial output. Pod, Deployment, Service and
Node have describers; other kinds print `describe for the resource type "<resource>[.<group>]" is
not simulated yet` until phase 15. Objects from `-f` are not fetched again by the builder (as
RetrieveLazy), so a missing object is the describer's error. ResourceSlices are not served, so a
node has none (D-066's reasoning).

**D-077 — describe text is masked by section in the differential runner.** Golden describe output
comes from an oracle with KWOK and without the ServiceAccount, DefaultTolerationSeconds and
Priority admission plugins. `maskDescribe` (tools/src/golden/kubectl/mask.ts) parses both sides
into tab-writer cells, removes the admission plugins' lines (`Priority:`, `Service Account:`, the
kube-api-access mount and volume, the two 300 s NoExecute tolerations), writing what kubectl
prints for a section left empty, and on steps marked `kwok` replaces KWOK-authored values (Pod
status, container ids and states, condition statuses, Node conditions, the Lease) with `<<kwok>>`
and drops kubelet event rows; then renders both sides again. Output that does not parse as one
tab-writer rendering is compared unmasked, so a mask cannot hide kubectl's own layout.

**D-078 — delete waits per object in virtual time under one deadline.** After deleting, kubectl
gets each object (checking its UID), lists, and watches it by name until DELETED, with one
deadline for all (a week when `--timeout` is 0), as delete.go's wait does; requests take no
virtual time, so a timeout below 1 ms is rounded up to 1 ms. A negative `--timeout` with waiting,
and `-A` with `-f`, print notices (their upstream handling is outside the checkout or not
modeled).

**D-079 — Transcripts and `npm run sim` place files, not objects.** The `# objects:` header and
`--objects` are gone. `# file: <path>` (transcripts) and `--file FILE[,FILE]` (sim) put files
into the session user's home directory, owned by that user with umask 022 (`placeFile` in
`packages/host/src/transcript/place.ts`); objects are created by setup lines
(`% kubectl create -f workloads.yaml`, `% sleep 30`), through the simulated kubectl.

**D-080 — COVERAGE's kubectl section is generated from registrations.** `npm run coverage:generate`
writes it from the command manifest, `VERBS` (flags, `noEffect`, and two optional fields added
for it: `partial`, flags that print a notice for some values, and `outputFormats`), `GLOBALS`,
the help-only commands and the API server's discovery registry and strategies; a gate test fails
when it is stale. The generator throws when a verb registers a flag the real command lacks.

**D-081 — API warnings are collected once per request.** `pkg/api/pod/warnings.go` is ported in
`apis/core/validation/podwarnings.ts`, next to the Service warnings, and used by the Pod,
Deployment, ReplicaSet and DaemonSet strategies as upstream calls it. The apiserver's warning
recorder (deduplication, the 4096-rune budget and 256-rune truncation) runs once at the end of
`handle()`, after the deprecation warning is put first (`apiserver/warning.ts`). Warnings that
upstream produces by iterating a Go map are emitted in sorted key order (DIV-017).

## Phase 08 (2026-11-16)

**D-082 — explain's OpenAPI v3 documents are captured from the real API server.** At v1.37.2 the
checked-in `api/openapi-spec/v3` of the upstream checkout has no `enum` keys and none of the
"Possible enum values" description text, while the real server serves both and `kubectl explain`
prints them. `npm run openapi:capture` (`tools/src/openapi/capture.ts`) starts an oracle without
KWOK, reads `/openapi/v3` and every group version's document with `kubectl get --raw` (rank 1),
and writes `packages/k8s/src/openapi/data/<tag>.openapiv3.ts`; `--check` compares a fresh capture.
This replaces D-038's plan of `api:vendor --descriptions`, which is gone.
- The documents are reduced to what explain's template reads (description, type, items,
  additionalProperties, allOf, `$ref`, properties, required, enum, externalDocs,
  x-kubernetes-group-version-kind), each operation's GVK and the per-document differences
  (DeleteOptions' and WatchEvent's GVK lists): 12 MiB become 1.1 MiB (196 KiB gzipped), parsed
  on the first explain. Capture fails if a reduction empties a schema, because the template tests
  schemas for emptiness.
- `apiserver/openapi.ts` serves `/openapi/v3` and `/openapi/v3/<path>` from them; explain calls it
  through the session's server, without a generic non-resource hook.
- Field paths go through a port of the part of client-go's jsonpath parser they reach (fields,
  escapes, `..`, `*`); other syntax prints a notice rather than guessing the parser's errors.
- Rules out serving explain from the checked-in spec, which would print fields without their enums.

**D-083 — Rollouts of DaemonSets and StatefulSets print a notice until phase 18a.** DaemonSets
are stored but no controller maintains their status or ControllerRevisions, so `rollout status`
would wait forever and `history`/`undo` would be wrong; StatefulSets are not stored. status,
history, undo and restart print `[sim] … rollout <verb> of a DaemonSet (phase 18a)`. pause and
resume print kubectl's real "pausing is not supported" error, which needs no controller.

**D-084 — JSON patch is a port of json-patch v4, and its panics are gaps.** `rollout undo` sends a
JSON patch, so the API server applies them (`apimachinery/jsonpatch.ts`, json-patch v4.13.0
DecodePatch and Apply, checked against the Go library with a 40 000-case differential fuzz;
`apiserver/jsonpatch.ts` for the strict decoding and the 400/413/422 statuses). Inputs that make
the Go library panic (a `test` of arrays holding null, a whole-document `replace` without a value)
make the real server drop the connection (the oracle's capture failed with "socket hang up"), so
there is no response to reproduce: the API server records a gap instead.

**D-085 — Commands that print typed objects print `-o json` in struct field order.** Generators and
the rollout verbs print typed Go objects, whose JSON keys follow the struct declaration (the
vendored schema's field order), not the sorted order of an unstructured object. One printer does it for every verb: `kubectl/cmd/typed.ts` (`typed`, `typedPrinter`; with a type id it only canonicalizes, without one it finds the Go type from apiVersion and kind and decodes first).

**D-086 — One kubeconfig model, with `kubectl config`'s writer.** `client/kubeconfigmodel.ts` is
a full round trip of clientcmd's v1 Config that remembers which file each entry came from,
because ModifyConfig rewrites whole files exactly as latest.Codec writes them
(`cmd/config/modify.ts`: the file chosen by PathOptions, mkdir 0755, file 0600, `.lock` files).
`client/kubeconfig.ts`, which every other verb uses, keeps its small view (servers, contexts, user
names) but decodes files with this model, so every verb reports the real load errors: Go's type
errors, a wrong apiVersion or kind, read errors such as ENOTDIR, and a repeated name as the
conversion error with Go's `%v` of the v1 list (deterministic for the fields the model keeps).
Content the model does not cover (exec and auth-provider credentials, `extensions`, a repeated
name in a list that holds them, migrating `~/.kube/.kubeconfig`) and writes to clusters, users or
preferences (set-cluster, set-credentials: phase 15) print notices; kubeadm's files contain none
of them. `--merge` is a Tristate whose default counts as set, so `view --kubeconfig f` still
merges and only `--merge=false` reads one file (checked against the binary: component-base is not
in the checkout).

**D-087 — The simulated API server serves legacy discovery and a fixed version.**
`apiserver/nonresource.ts` answers `/version`, `/api`, `/apis`, `/api/v1` and `/apis/<g>/<v>` from
the registry (checked against all 25 discovery GETs of `api/discovery.yaml`), not aggregated
discovery (apidiscovery v2); the client therefore has no `storageVersionHash`. `/version` is the
pinned kube-apiserver's build info read from the oracle (buildDate 2026-10-27T12:01:06Z), a
constant until a phase that upgrades the control plane (29b) moves it into the server's config.

**D-088 — `pods/log` is a stream served beside the request pipeline.** `apiserver/log.ts`
(`openPodLog`, `readPodLog`) is LogREST: PodLogOptions validation, LogLocation (the container
checks; a Pod with no node answers empty), the node's address in kubeadm's preferred order and
its kubelet port, the kubelet URL with LogLocation's query. It sits outside `handle()`, as watches
do, because the answer is bytes, not an object. The kubelet side (`kubelet/logs.ts`) is
validateContainerLogStatus and ReadLogs over the CRI file; the kubelet reads the Pod and its
status from the API object, standing in for its pod and status managers. A kubelet that is not
running on the machine that holds the node's address refuses the connection (the API server's
500 with Go's dial error); an address no machine holds or a machine that is off prints a notice,
as the transport does, until phase 17.
- **Streaming.** One topic, `k8s.logs`, is published on every log append, container exit,
  container removal and kubelet stop; a follower re-reads from its offset on each publish (for
  fsnotify and waitLogs' container check). One topic rather than one per node, because a `-l -f`
  follower spans nodes and a process waits on one topic; a publish nobody waits for changes no
  hash. A kubelet stopping mid-stream ends the stream with status 0, as StreamObject ignores
  io.Copy's error.
- **Order of several streams.** kubectl ranges over a Go map. v1.37.2 is built with Go 1.26, whose
  small maps (up to 8 entries) iterate in insertion order rotated by a random offset; the
  simulator draws that offset from the stream `kubectl.logs.requests` and shuffles above 8.
- **Retries.** `--pod-running-timeout` retries every second; at the deadline the deadline wins the
  tie with the ticker (attempts at 0 … N−1 s, then "context deadline exceeded").

**D-089 — Generators: validation first, then the notice; `run`'s name check as the binary does
it.** `kubectl run -i/-t/--attach/--rm` print the phase 17 notice after Complete and Validate, so
their real errors still show, and before anything is created. `run`'s NAME check ignores
ArgsLenAtDash, because RecordFlags.Complete re-parses `os.Args[1:]`, where `run` precedes any
`--` (`kubectl run --image=x -- name` is accepted; checked against the binary). Typed output
follows D-085 (`cmd/generate/common.ts` encodes through the vendored Go types, `--save-config`'s
annotation too). An `--overrides` patch that removes or retypes apiVersion or kind prints a
notice. The container name suffix of `create deployment` with several images comes from the
stream `kubectl.rand`; `--append-hash` uses a SHA-256 port (`cmd/generate/sha256.ts`), since the
engine has no crypto.

**D-090 — kubectl completion is on, as kubectl's documented setup configures it.** Every machine
completes kubectl as if `source <(kubectl completion bash)` were in `~/.bashrc` (as on the CKA
exam machines): our bash runs no completion scripts until phase 22a, and bash-completion's
behavior is reproduced by completers (D-025). An alias completes with the completer of the
program its value starts with, which models `complete -o default -F __start_kubectl k`; flags in
the alias value take part, as the script's eval of `k __complete …` expands them. The Tab
completer and the hidden `kubectl __complete` command run one port of cobra's `getCompletions`
over the vendored manifest with kubectl's completion functions (`completion/cobra.ts`,
`functions.ts`; lookups as the process's user, `client.ts`); its stdout is fed to a port of the
V2 script's presentation (`bash.ts`) and its stderr is dropped, as the script's `2>/dev/null`
does. Checked two ways: `__complete` against the binary (805 golden steps) and screens key by key
against real bash 5.2.21 with bash-completion 2.11 and the real script
(`fixtures/reference/bash/kubectl-completion.json`).

**D-091 — `kubectl edit` runs the editor as a child process on a temporary file.** The editor is
`KUBE_EDITOR`, else `EDITOR`, else `vi`; a value with spaces is split, or run through
`$SHELL -c` when it holds quotes or backslashes (editor.go). It is looked up as Go's LookPath does
(a regular file with an execute bit; an empty PATH entry is `.`) and executed as os/exec does: a
`#!` script runs its interpreter, a file without `#!` is "there was a problem with the editor",
with no `/bin/sh` fallback. The temporary file is `os.TempDir()` (`$TMPDIR`, else `/tmp`) plus
`kubectl-edit-<uint32>.yaml|.json`, mode 0600, the number drawn from the stream
`kubectl.edit.tempfile` and redrawn on EEXIST. `vi`, `vim` and `nano` then use the editor
protocol, so the UI's overlay, the terminal player's `$EDITOR` and headless answers all work.
- Transcripts answer editors with `@editor <<WORD … WORD` (content to save) and `@editor :q!`
  (close without saving), queued in order for the next editors (docs/TRANSCRIPTS.md); `npm run
  sim` accepts the same. Golden cases get real editor behavior by setting `KUBE_EDITOR` to a
  script from the case's `files:` run with bash. Fixtures normalize the file's number to `<<tmp>>`.
- Where kubectl iterates a Go map (label/annotate `--list`, overwrite errors, set image's
  not-found errors) the simulator uses argument order, and sorted keys for `--list`; golden steps
  pipe through `sort` or mark `unorderedLines`.
- A kind without a scale subresource answers the generic 404 client-go builds ("the server could
  not find the requested resource"). `kubectl scale` has no conflict-retry loop: the server is
  synchronous, nothing can come between its GET and PUT.

**D-092 — The scale subresource is writable.** `apiserver/scale.ts` takes update and patch (merge
or strategic) of `<resource>/scale`, validates the Scale (ValidateScale, Invalid on
`Scale.autoscaling`), checks a PUT's UID as the storage precondition, moves replicas and
resourceVersion onto the object and sends it through the main strategy's update, and answers
with the autoscaling/v1 Scale; a missing object is NotFound on the parent resource. This ends
D-045's read-only shortcut.

## Phase 09 (2026-11-16)

**D-093 — The engine validates content with its own JSON Schema validator.** `learn` runs in a
Web Worker and in Node and imports only `kernel`, so it takes no schema library:
`packages/learn/src/item/jsonschema.ts` validates the 2020-12 subset the item schema and the
registered argument schemas use, and refuses any keyword outside it rather than ignore it.
`tools/src/content/schema.test.ts` compiles the generated schema with Ajv in strict mode and checks
that both agree on every item, every worked example and broken variants of each. Ajv stays a
development dependency of `tools`. Rules out adding Ajv to `learn` (code generation at run time,
a second copy of a library the root already has in another major version).

**D-094 — Runner contracts.** Additions to `docs/ARCHITECTURE.md` §2.11, all in `kernel`:
- `StepSession` (`entry`, `local`, `onEnd`, `listen`): the per-list context the runner holds
  outside the world. A step kind keeps state under its own key (the host keeps one shell per
  machine and user), registers what to do when the list ends (log out), and listens to the
  kernel's ports through the runner's hub, because ports are fixed when a kernel is created.
  `StepCtx` and `CheckCtx` carry it; `shell.exec` and the `apply` step use the same shells.
- `CheckCtx.baseline`: the world as setup left it, read-only, for constraint checks.
- `CheckResult.expected`: what the check wants, in words from its arguments, next to `observed`.
- `StepSpec.show`: how a step reads in a reference solution (`$ kubectl …`, a heredoc for
  `write`).
- `advance` and `until` are implemented by the runner, not registered by a plugin: they need
  only the kernel and the check registry, and `until` needs the baseline.

**D-095 — Waiting checks poll.** `until` steps and `within` look at the world now, then once per
poll interval: one second, or a sixtieth of the time they may wait when that is longer. Each look
is a fresh fork, so a check that types commands or deletes things stays harmless. Polling at every
event instant would cost hundreds of forks per minute of virtual time (kubelet heartbeats alone
are every 10 s per node); the rule caps a wait at about sixty evaluations, which keeps
`content:check` of three labs on five seeds under twenty seconds.

**D-096 — Weights and partial credit.** A check may carry `weight` (a number above 0, default 1).
The grade has a score, the passed weight over the total; the item passes only when every check
passes. The score is for the rating in phase 11 and for the learner ("75% of the checks' weight
passes"); it never turns a failed constraint into a pass. Not in phase 00's format; added because
the phase prompt asks for partial credit.

**D-097 — The `apply` step runs the simulated kubectl.** It types `kubectl apply -f - <<'…'` with
the documents into a root shell on the machine that holds the API server's advertise address,
with `KUBECONFIG=/etc/kubernetes/admin.conf`. The world then holds exactly what a person running
that command leaves (last-applied annotation, managed fields, events) and a wrong manifest fails
with kubectl's own error. Rules out calling the API directly, which would skip kubectl's
three-way merge and its annotation.

**D-098 — Any gap fails a step.** A step fails when the engine reports a gap while it runs: a
command's `[sim]` notice, and also a behavior model's gap during the time the step lets pass (an
image whose start is not fully captured, such as `nginx:1.27`). Content therefore uses only what
the simulator knows; the labs use `nginx:1.31.8` and `nginx:1.14.2`, whose models report no gap.
In a check, a gap in the `after` steps or in `shell.exec`'s command makes the check an error; gaps
while a `within` waits are the session's business and are not held against the check.

**D-099 — `npm run lab`: the lab prompt is behind Ctrl-].** The terminal player's escape key
(play's "leave") opens a `lab>` prompt in lab mode: `check`, `hint`, `ticket`, `debrief`,
`solution`, `reset`, `help`, `quit`; an empty line returns to the shell. The commands that give
the answer away or throw work away (`debrief` before the lab is solved, `solution`, `reset`) ask
to be typed twice. Each attempt is a session log under `data/lab/`; `reset` ends one and starts the
next from the baseline (§2.8 "Reset starts a new log"); hint, check, solution and reset are
logged as `learn.action` inputs. An interactive attempt starts at the real current time, rounded to
the second, as the format says; the header records it and the item's content hash, so `--replay`
rebuilds the same world and refuses an item that changed.

**D-100 — Packs are read by `@simlab/content`, from its entry point.** `pack.yaml` holds the
pack's `id`, `title` and the skills it defines (`id`, `title`); phase 11 extends it. YAML 1.2 is
parsed with `yaml` 2.9.1 (already in the lockfile, now a runtime dependency of `content`), with
duplicate keys as errors. The loader reads the file system with Node APIs and is exported from
the package entry point, because the boundary rule allows no subpath imports; `content` is not an
engine package. Phase 10 decides how items reach the browser (the server, or the bundler).

**D-101 — The worked examples are validated with stand-ins for planned checks.** The examples in
`docs/SCENARIO_FORMAT.md` §13 use `host.unit`, `net.reach`, `k8s.nodeReady` and faults that later
phases build, so the generated schema refuses them. `tools/src/docs/planned.ts` registers
stand-ins with the phase 00 argument schemas and the phase that builds each; a test fails as soon
as a real plugin registers one of the names, so the stand-in is removed in the same phase.

**D-102 — Taints in setups are applied with `kubectl edit node`.** `kubectl taint` is simulated in
phase 26b; until then a setup that needs a taint edits the Node, which is a real administrator's
path and leaves no annotation a `taint` would not leave either. A learner who reaches for
`kubectl taint` gets the `[sim]` notice; in the scheduling lab that is the forbidden fix anyway.

**D-103 — Content reaches the browser through the bundler.** Answers D-100's open question.
`apps/web/vite.config.ts` reads the packs with `loadPacks()` at build time (Node) and serves them
as the virtual module `virtual:simlab/content`, to the page and to the worker (which Vite bundles
separately, so the plugin is registered for both). The browser never imports `@simlab/content`'s
file system loader, and no content is fetched at runtime. Validation stays with
`npm run content:check`; the dev server reloads the page when a pack file changes.

**D-104 — The web engine is one attempt at a time in a worker, behind a message protocol.**
`apps/web/src/protocol.ts` is the whole interface: terminal bytes, `tty.open`/`resize`/`close`,
editor save and close, lab actions (check, hint, debrief, solutions, reset), pause, speed and
advance, and `flush`. `src/engine/session.ts` is the worker's logic without the worker (tested
in Node with a fake clock); `worker.ts` adds the wall clock. Everything one message or tick
produces is sent after it, consecutive bytes for one terminal in one message. The lab's actions
are `learn.action` inputs, as in `npm run lab`; after a reload the hints shown, the solutions
viewed, the debrief read and "solved" are derived from those inputs across every attempt, so the
log stays the only source of truth. The last check's report is display state, stored beside the
log. Terminal ids are the first free `ttyN` of the world (setup terminals keep theirs).

**D-105 — Attempts live in browser storage until phase 11.** `simlab.attempt.v1.<item>` holds a
`StoredAttempt` (the current `SessionLog`, earlier attempts ended by reset, the start time and
seed); `simlab.active.v1` names the item to resume on load; `simlab.settings.v1` holds theme,
editor keys, panel width and font size. The worker sends the whole attempt at start, after lab
actions and resets, and each new input at once as a delta (`attempt.delta`, with `end` every 5 s
while only time passes); the page holds the attempt (`app/attempts.ts`), writes it 300 ms after a
change and synchronously when the page is hidden or unloaded. A first version let the worker send
the attempt every 250 ms and lost the last keystrokes when the page reloaded right after them; a
message from the worker cannot arrive once unload has begun. A reload replays the current log into a
fresh fork of the baseline (`createRecorder(kernel, header, from)` continues the same log); its
terminal output goes back to the terminals, open editor sessions reopen with their last saved
content, and a log whose checkpoints do not match, or whose item changed (`contentHash`), is
refused with an offer to start the same variant again (§2.8: never continue on a world the
simulator cannot vouch for). Checkpoints are taken at every lab action and at most every 2 min of
virtual time otherwise (a hash costs about 40 ms). Every storage access is guarded; a full or
missing storage shows a warning.

**D-106 — The worker wakes when the next event is due.** Ticking every 50 ms made every command
that consumes virtual time (all kubectl calls) wait for the next tick: p95 31.8 ms. The worker now
sleeps until `nextEventTime()` at the current speed, at most 250 ms: p95 8 ms, and fewer wakeups
while idle. Sleeping longer is invisible: every input first lets virtual time catch up.

**D-107 — The editor overlay holds lines the way vim does and speaks vim's words.** CodeMirror 6
with `@replit/codemirror-vim` for the vim flavor (or plain keys by setting; nano is always plain,
with Ctrl-O and Ctrl-X). The file's final newline is taken off on open and put back on write
('fixendofline'), so `G` and `dd` see vim's lines. `:w`, `:wq`, `:x`, `:q`, `:q!`, `ZZ`, `ZQ` (and
`:wa`, `:qa`, `:up`, `:exi`, `:clo`) map to `editor.save` and `editor.close`. The message line uses
the strings captured from vim 9.1 (`fixtures/reference/vim/messages.py`): the file information on
open and after a write (`"f" 2L, 10B`, `[New]`, `[readonly]`, `[noeol]`), E37, E45, E492, the mode
names. The vim emulation's own "Not an editor command" text is replaced: a name vim has (any
prefix of `getcompletion('', 'command')`) that the overlay does not do is a `[sim]` notice and a
gap record (`:sp`, `:e`, `:w other-file`); anything else is vim's E492. `EditorRequest.isNew` tells
the overlay that the file does not exist yet. Long lines wrap (vim's 'wrap'). The emulation's
other messages (bad regex, marks) are its own words; DIV-014 says so.

**D-108 — Workspace shortcuts are Ctrl+Shift chords.** A terminal sends the same byte for
Ctrl+Shift+letter as for Ctrl+letter, so the chords cost the shell nothing, and the chosen ones
are not reserved by browsers: Enter check, H hint, E new terminal, X close terminal, 1…9 switch,
L panel, Space pause, O lab list, C copy, ? shortcuts. Ctrl+Shift+V is never handled: the browser's
paste event reaches xterm.js. They are caught in the capture phase, before xterm.js or CodeMirror.
Ctrl-] keeps its readline meaning in the browser (the lab commands are buttons). Escape that
closes a popover or the lab list is stopped there; it would otherwise reach the shell as a meta
prefix.

**D-109 — One local server for development and use.** `apps/server` listens on 127.0.0.1 (port
4317, `--port`): `/api/gaps` appends posted gap records to `data/gaps.jsonl` with the wall-clock
`at` (`--data` points elsewhere; the browser tests use `.tsbuild/playwright/data`), then either
the built app from `apps/web/dist` (`npm start`) or Vite in middleware mode with hot reload on the
same server (`npm run dev`). The page posts gaps in batches and by `sendBeacon` when it is hidden;
the item goes into the record's `context`, as `docs/FIDELITY.md` §4.4 specifies (`npm run lab`
wrote it at the top level; fixed). Phase 11 adds the persistence API here.

**D-110 — Browser tests run outside the gate.** `npm run e2e` (Playwright 1.64.1) builds the app,
serves it and runs the smoke test and the exit-criteria tests: the three labs solved through
`kubectl edit` and `vim`, reload and resume, the workspace (copy and paste, tabs, pause, plain
keys), no request off the local server, and the latency measurement (`npm run bench:web`).
Playwright is pinned to 1.64.1 because its Chromium headless shell (revision 1248) is the one
already in `~/.cache/ms-playwright`; a newer Playwright would download a browser outside the
repository. The gate stays fast and needs no browser; the e2e suite takes about 40 s. The
latency is measured in the page: from sending Enter to the prompt being back on the cursor line
after xterm.js parsed the output (`painted` adds the next animation frame).

**D-111 — How the web app starts a lab.** A new attempt gets a random seed (0–999 999) and starts
at the real current time, rounded to the second (`docs/SCENARIO_FORMAT.md` §5.2, as `npm run lab`).
`?lab=<id>&seed=<n>` opens that variant directly (tests, sharing a variant with yourself later).
The clock in the top bar is virtual time spent in the item over every attempt: it stops while
paused and while the page is closed.
