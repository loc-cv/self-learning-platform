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
`kwok-v0.8.0` placeholders, and no Node `phase` is invented. What KWOK writes is never treated as
kubelet output: fixtures list it under `kwokAuthored`, and steps and objects that show it carry
`kwok: true` (`docs/FIDELITY.md` §6.5).

**D-037 — Scheduling ties are a token, not a pinned node.** With two identical workers the
scheduler picks among equal scores at random (upstream: `pkg/scheduler/schedule_one.go`
`selectHost`). A case that needs `kubectl run` as typed, without a node selector, marks the steps
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
they are generated only with `--descriptions`; the explain phase turns that on.
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
phase with `kubectl scale` builds that, a write is a gap rather than a wrong answer.

**D-046 — Differential tests strip what admission plugins of phase 20b add, field by field.**
Rather than listing whole steps as known differences, `tools/src/golden/api.test.ts` and
`defaulted.test.ts` remove the fields the ServiceAccount, DefaultTolerationSeconds and Priority
plugins write from both sides of Pod responses, so that every other field (graceful deletion,
generation, defaults) is still compared with the real server. Phase 20b deletes the stripping.
