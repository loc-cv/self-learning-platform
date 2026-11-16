# Fidelity

How Simlab stays honest about what it simulates. This document holds the version pin, the order
in which sources are trusted, the provenance tags, the contract for `[sim]` notices and the gap
log, the register of known divergences, and the oracle that produces golden fixtures (§6). `PLAN.md` §9 is the policy; this is the contract code
is written against.

## 1. Version pin

| | |
|---|---|
| Kubernetes version | **v1.37.2** |
| Constant | `KUBERNETES_VERSION` in `packages/k8s/src/version.ts` (the only place it is written in code) |
| Git tag | `v1.37.2` → commit `c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32` in `kubernetes/kubernetes` |
| Date checked | 2026-11-13 |
| Exam version | CKA and CKAD: "The exam is based on Kubernetes v1.37." |
| Curricula | v1.37 for both, recorded in `docs/curriculum/` |

Sources, all read on the date above:

- CKA exam page: <https://training.linuxfoundation.org/certification/certified-kubernetes-administrator-cka/>
- CKAD exam page: <https://training.linuxfoundation.org/certification/certified-kubernetes-application-developer-ckad/>
- Latest patch of the minor: <https://dl.k8s.io/release/stable-1.37.txt> returned `v1.37.2`; the
  tag list of <https://github.com/kubernetes/kubernetes> shows `v1.37.2` as the newest `v1.37.*`
  tag. Release overview: <https://kubernetes.io/releases/>.
- Release binaries for the oracle (phase 04): `https://dl.k8s.io/release/v1.37.2/bin/linux/amd64/`
  answered for `kube-apiserver`, `kubectl` and `kubeadm`.
- Rechecked on 2026-11-15 from the current workstation (§2.1): `stable-1.37.txt` still returned
  `v1.37.2`, and `kube-apiserver`, `kube-controller-manager`, `kube-scheduler`, `kubectl` and
  `kubeadm` all answered at that URL.

The exams name a minor, not a patch. The pin is the latest patch of that minor on the day it was
checked. `PLAN.md` §4.1 was written when 1.37.1 was the latest; 1.37.2 appeared since
(`docs/decisions.md` D-001).

Rules:

- Data derived from upstream (processed OpenAPI, golden fixtures) is stored in a directory named
  after the version, for example `fixtures/golden/v1.37.2/`.
- Nothing else in the code states a version. Tools import the constant.
- Moving the pin is `prompts/R5-version-bump.md`: refetch upstream, recapture goldens, diff, fix,
  update this section and `docs/curriculum/`.
- A `kubectl` installed on the workstation is not a reference for anything (the current one has
  none; the previous one had 1.36.3). The reference `kubectl` is the v1.37.2 release binary that
  phase 04 downloads.

### Node runtime: containerd, runc and Go

The simulated nodes run containerd. Its version is written once, as `containerRuntimeVersion` in
`packages/k8s/src/topology/nodes.ts`; the upstream fetch derives the containerd tag from it.

| Source | Tag → commit | Why this version |
|---|---|---|
| `containerd/containerd` | `v1.7.28` → `b98a3aace656320842a23f4a392a33f46af97866` (2025-07-25) | The nodes' `containerd://1.7.28`, chosen with the rest of the node software in D-033. In 1.7 the kubelet talks to the CRI plugin in `pkg/cri/server` (`pkg/cri/sbserver` only with `ENABLE_CRI_SANDBOXES`) |
| `opencontainers/runc` | `v1.3.0` → `4ca628d1d4c974f92d24daccb901aa078aad748e` (2025-04-29) | The runc containerd v1.7.28 pins in `script/setup/runc-version`; the fetch fails if the two drift apart |
| `golang/go` | `go1.23.11` → `0a75dd7c2dcf7057ef200290d8f5c4c1514dba80` (2025-07-08) | `GO_VERSION` of containerd v1.7.28's release build (`.github/workflows/release.yml`); runc v1.3.0 builds with Go 1.23 too. Standard-library error texts that reach a learner (`exec.LookPath` in the container, DNS and dial errors of the registry client, errno strings) come from here |

Date checked: 2026-11-16, from the tags of the three repositories. A distribution's package of
the same containerd version may bundle another runc or build with another Go; the simulator
follows these upstream pins.

### Programs of the catalog images

The behavior models of the official images' programs (`docs/BEHAVIOR_MODELS.md` §3.2) print what
the program's source prints at the version the captured image ships (`NGINX_VERSION`,
`HTTPD_VERSION`, `REDIS_VERSION` of its config, `npm run images:capture`). Build facts no source
holds (the `built by gcc` line, `nginx.conf`'s `error_log`, the redis binaries' dirty flag) were
read from the images' layers in phase 06b and are cited next to the code.

| Source | Tag → commit | For |
|---|---|---|
| `nginx/nginx` | `release-1.31.8` → `140aa942711868a8daeb95810bc9a81f272ada72` | nginx:latest/mainline and nginx:alpine (1.31.8); older tags reuse these notices with their own version |
| `apache/httpd` | `2.4.71` → `4554c7436049b6a68bfee7fbae32fc5ced666355` | httpd:2.4.71 and httpd:alpine |
| `redis/redis` | `8.10.3` → `1a2574ce`, `7.4.12` → `f9bc2f89`, `7.2.17` → `83937c51`, `6.2.24` → `bfb69472` | each redis tag in the catalog |
| `kubernetes/kubernetes` `build/pause` | the Kubernetes pin | the pause container |

Date checked: 2026-11-16. When the catalog is recaptured and a tag moves to a new version, these
pins move with it (and the models' version tables).

### Upstream checkout

`npm run upstream:fetch` makes a sparse, blob-less, depth-1 clone of each pinned tag under
`.upstream/` (git-ignored): `kubernetes/` (about 200 MB), `containerd/` (about 9 MB), `runc/`
(about 2 MB) and `go/` (part of the standard library, about 17 MB). Each writes
`.upstream/<name>.json` with the repository, tag, commit and directory list. The repositories
and their directories are listed, with what reads each directory, in
`tools/src/upstream/paths.ts`. A phase that needs another directory or another repository (a
workload's source, CoreDNS) adds it there and reruns the command; it is incremental.

## 2. Source hierarchy

Every user-visible string and format has a source. When two sources disagree, the higher one wins
and the disagreement is worth a note next to the code.

| Rank | Source | Used for | How it is cited |
|---|---|---|---|
| 1 | **Golden capture** of the real binaries at the pin: the local oracle (API server, etcd, controller manager, scheduler, `kubectl`, `kubeadm`; phase 04) and, optionally, a kind cluster (tier 2, phase 32) | Everything those binaries print or store: tables, `describe`, errors, events, defaulted objects | The fixture path: `fixtures/golden/v1.37.2/<case>` |
| 2 | **Upstream source** at the pinned tag in `.upstream/` | Formats and strings the oracle cannot produce (kubelet and node output), and the logic behind any output | `// upstream: <path> <symbol>` |
| 3 | **The real tool on this workstation** (§2.1): bash, GNU coreutils, systemd, OpenSSL, vim | Shell, coreutils, `systemctl`, `journalctl`, `openssl` output | `// reference: <tool> <version>, captured <date>` and a transcript fixture |
| 4 | **Official documentation**: kubernetes.io, man pages, project docs for etcd, containerd, Helm, CoreDNS | Behavior and formats not covered above | `// docs: <URL>` |
| — | Memory, blog posts, answers from an LLM | Nothing | — |

For a tool whose source is not in `kubernetes/kubernetes` (etcd, containerd and `crictl`, Helm,
CoreDNS, kustomize as a standalone binary), the phase that introduces it records its pinned
version here and fetches or captures its sources the same way.

### 2.1 The workstation

Rank 3 is whatever this machine has, so its versions are recorded here. A provenance comment names
the version it was captured from (`// reference: bash 5.2.21, captured <date>`), which keeps it
meaningful if the work moves to another machine. When the workstation changes, update this section
and add a handoff note in `STATUS.md`.

Recorded 2026-11-15, after the move from the machine phase 00 ran on. Only phase 00 ran there, so
no rank 3 reference comes from the previous machine.

| | |
|---|---|
| System | Pop!_OS 24.04 LTS, a desktop derivative of Ubuntu 24.04 ("noble"); x86_64, 16 CPUs, 31 GiB RAM |
| Development runtime | Node 26.13.1 (through nvm), npm 11.20.0, git 2.43.0 |
| Shell and text tools | bash 5.2.21, GNU coreutils 9.4, GNU grep 3.11, GNU sed 4.9, GNU findutils 4.9.0, GNU diffutils 3.10, jq 1.7.1 (`jq --version` prints `jq-1.7`), less 590, vim 9.1, GNU tar 1.35, gzip 1.12 |
| awk | GNU Awk 5.2.1 is what `awk` runs here, as on the simulated hosts (the Ubuntu 24.04 cloud image installs gawk, whose alternative outranks mawk's; `docs/decisions.md` D-032). mawk 1.3.4 is `/usr/bin/mawk` on both. Call each by its full name when capturing |
| System tools | systemd 255, procps-ng 4.0.4, iproute2 6.1.0, util-linux 2.39.3, sudo 1.9.15p5, apt 2.8.4, OpenSSH 9.6p1, OpenSSL 3.0.13 |
| Network clients | curl 8.5.0, GNU Wget 1.21.4, OpenBSD netcat 1.226, iputils ping, `nslookup`, `dig` and `host` from BIND 9.18.39 |
| Browsers | Firefox 160.0; a Playwright headless Chromium (build 1248) is in `~/.cache/ms-playwright` |
| Not installed | `kubectl`, Docker, Podman, kind, Helm, `crictl`, pnpm |
| Installed, unused by the plan | Go 1.27.4, Python 3.12.3 |

**Capture in a clean bash, never in the agent's shell.** The shell Claude Code runs commands in is
the owner's zsh with oh-my-zsh. There, `grep` is a function that runs ugrep and `find` one that
runs bfs (both bundled with Claude Code), and `ls`, `grep` and `diff` are aliases that add color
and exclude options. What they print is not GNU output. Run the real tool in a temporary directory
like this:

```sh
env -i HOME="$HOME" PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 TERM=xterm-256color \
  /bin/bash --noprofile --norc -c '<commands>'
```

`type grep find ls diff` inside it shows `/usr/bin/…` for each. Choose the locale on purpose and
record it with the transcript: `sort`, `ls` and some messages depend on it. The owner's login
locale is `en_US.UTF-8`; `C.UTF-8` is also available. Simulated machines use `C.UTF-8`
(`docs/decisions.md` D-022), and captures use it too. `npm run transcript:capture` does all of this
for transcripts (`docs/TRANSCRIPTS.md`).

**Take formats from this machine, not contents.** Simulated hosts are Ubuntu servers; this is a
desktop with Pop!_OS changes. Layouts, message formats, exit statuses and error texts transfer.
These do not: `/etc/os-release` and other identity files, which units, users and services exist,
the apt sources and their priorities (Pop!_OS pins its own repository at priority 1001 in
`/etc/apt/preferences.d/pop-default-settings`; there are also Tailscale and Ubuntu Pro entries),
the motd. Take those from Ubuntu server documentation (rank 4) and say so.

**Where captures live.** A rank 3 capture that a test compares against is committed under
`fixtures/reference/<area>/`, with the script that produced it. The script's header gives the
command, the locale and the tool versions (`docs/decisions.md` D-021). Example:
`fixtures/reference/linux/vfs-syscalls.{py,txt}`.

**Missing tools.** When a phase needs real output from a tool listed as not installed, ask the
owner to install it (`CLAUDE.md` forbids changing the workstation yourself), or use rank 2 or 4
and tag the unit by what could be verified.

## 3. Provenance tags

An **output unit** is one piece of user-visible output with one origin: a table printer for a
kind, a describer, one family of error messages, one program's help text, one event reason with
its message format. Every unit is registered with one tag.

| Tag | Meaning | Requirement |
|---|---|---|
| `golden-verified` | A differential test compares the simulator's output with a committed capture of the real tool, after normalizing volatile fields | The fixture exists and the differential test passes in the gate |
| `source-derived` | Written from upstream source or official docs at the pin, not yet compared with real output | The code cites the source |
| `approximate` | Known to differ from the real tool, or grounded in no source | An entry in the divergence register (§5) that the unit links to |

Registration is data next to the code that renders the unit:

```ts
interface ProvenanceEntry {
  /** Stable dotted id: `<program>.<verb>.<what>`, e.g. `kubectl.get.pods.table`. */
  unit: string;
  tag: 'golden-verified' | 'source-derived' | 'approximate';
  /** Fixture paths, upstream paths with symbol, tool and version, or URLs. At least one unless approximate. */
  sources: string[];
  /** Divergence register id, required when tag is `approximate`. */
  divergence?: string;
  note?: string;
}
```

- The registry rejects a unit registered twice and a unit with no source.
- `npm run fidelity:report` (phase 07a) prints every unit with its tag and sources, and the counts
  per tag. A unit that code renders but nobody registered is a test failure, not a report line.
- A unit moves up, never silently down: `source-derived` becomes `golden-verified` when its
  differential test lands. A unit found wrong becomes `approximate` with a register entry until fixed.
- Normalization replaces volatile fields with tokens before comparison (ages, UIDs, IPs,
  timestamps, resource versions, generated name suffixes). The tokens and rules are in §6.4.

## 4. The `[sim]` notice and the gap log

Three outcomes exist for any input (`PLAN.md` §3.2): it works as the real tool would; it fails with
the real tool's real error; or the simulator says, in its own voice, that it does not simulate
this. The third outcome is the `[sim]` notice.

### 4.1 When a notice is printed

| Situation | Outcome |
|---|---|
| A program the real machine would have, not simulated yet (say `awk` before phase 22b) | Notice. The executable exists in the VFS and points at a stub, so `which` and tab completion behave. |
| A program the real machine would not have | The shell's real `command not found` error, exit 127. Also written to the gap log as kind `unknown-command`, because the list of what a machine "would have" is itself curated. |
| A supported program with an unsupported subcommand, flag, flag value, resource type, output format or field | Notice. The program does nothing else: no partial effect, no output. |
| Shell syntax outside the documented subset | Notice from the shell. The whole command line is not executed. |
| An input that hits a simulator bug (an uncaught exception in a program) | Notice of kind `internal`, with a short id that matches the gap log record. |
| A flag that is parsed and has no observable effect in a simulated world (for example `--request-timeout`) | Accepted silently only if it is on the program's documented no-effect list, each with a reason. Otherwise notice. |

What is never done: printing an error the real tool would not print; accepting a flag and ignoring
it; printing plausible output for something that was not computed from world state.

### 4.2 Format

One line on standard error:

```
[sim] <program>: <what> is not simulated yet
```

`<what>` names the unsupported thing in the user's terms: `the flag --server-side`,
`the resource type "podtemplates"`, `the subcommand "debug"`, `the "select" statement`. An
optional second line starting with `[sim] ` may point to what is supported instead. Examples of
the shape (the wording of `<what>` is fixed by the program that prints it):

```
[sim] kubectl: the flag --server-side is not simulated yet
[sim] bash: the "select" statement is not simulated yet
[sim] awk: this program is not simulated yet
[sim] kubectl: internal simulator error (gap 7f3a9c1e)
```

- The prefix `[sim] ` appears at the start of every line of a notice and nowhere in simulated
  output. No real tool prints it, which is the point.
- When standard error is a terminal each line is written in yellow (`ESC[33m` … `ESC[0m`,
  `styleNotice`, `docs/decisions.md` D-026), which the web UI and the terminal player render the
  same way. When it is a pipe or a file the line is plain. Notices from the line editor (a
  readline command that is not simulated) and the terminal (Ctrl-Z during a command) use the same
  style.
- The exit status is **250**. The value is the simulator's own and is reserved: no simulated
  program returns it for any other reason.
- All notices are printed through one function in the host package (`simNotice` in
  `packages/host/src/proc/notice.ts`, reached through `ProcApi.unsupported` and the shell's own
  `notice`). Programs never format the prefix themselves.

### 4.3 Consequences for content

- A reference solution that triggers a notice fails content validation. Solutions use only what is simulated.
- A setup step that triggers a notice fails content validation.
- A check never passes or fails because of a notice: `shell.exec` reports a notice as an error of
  the check, not as a result.

### 4.4 The gap log

Every notice, and every `unknown-command`, produces one gap record. Engine packages do no I/O:
the engine hands the record to the kernel's gap port (`docs/ARCHITECTURE.md` §2.10) and the app
appends it to `data/gaps.jsonl`, one JSON object per line.

```ts
interface GapRecord {
  /** Schema version of this record. */
  v: 1;
  /** Wall-clock time, added by the sink, ISO 8601. The engine does not know it. */
  at: string;
  kind: 'command' | 'unknown-command' | 'subcommand' | 'flag' | 'flag-value' | 'resource'
      | 'output-format' | 'field' | 'syntax' | 'behavior' | 'internal';
  program: string;
  /** The unsupported thing, as printed in the notice. */
  what: string;
  /** The command line as typed, after alias expansion. */
  commandLine: string;
  /** Stable key for grouping: kind, program and the normalized thing. */
  key: string;
  /** Where it happened. */
  context: { item?: string; seed?: number; machine: string; virtualTime: number };
  /** For `internal`: error message and stack. */
  error?: { message: string; stack?: string };
  engine: { version: string; kubernetes: string };
}
```

- The sink writes every occurrence. Grouping by `key` and counting is done when reading.
  `prompts/R3` works from the grouped view, most frequent first.
- Headless content validation and tests collect gap records in memory and fail on any.
- The file is append-only and local. It contains command lines I typed; it is under `data/`,
  which is git-ignored.
- `kind: 'behavior'` is for gaps found by code that knows it is not modeling something a scenario
  asked for (an image with no behavior model, a kubelet flag that is parsed but not acted on).

## 5. Divergence register

Places where the simulator knowingly differs from the real system. An entry is added by the phase
that introduces the divergence; debriefs link to entries by id ("in reality" notes). An entry is
removed only when the divergence is gone.

Entry format:

| Field | Content |
|---|---|
| Id | `DIV-NNN`, never reused |
| Area | Program or subsystem |
| Real behavior | What the real system does, with a source |
| Simulated behavior | What Simlab does instead |
| Why | The reason the divergence is accepted |
| Learner impact | What habit or expectation could be affected, and what the debrief should say |
| Since | Phase that introduced it |

### Register

| Id | Area | Real behavior | Simulated behavior | Why | Learner impact | Since |
|---|---|---|---|---|---|---|
| DIV-001 | `which` | debianutils' `/usr/bin/which` is a `/bin/sh` script (`cat` shows it) | An executable stub of the program `which`, with the script's size | `/bin/sh` is dash, which is not simulated | None in use; `cat /usr/bin/which` prints a notice | 02 |
| DIV-002 | Streams and files | Contents are bytes; binary and invalid UTF-8 data pass through untouched | Contents are Unicode text stored as UTF-8; byte escapes (`printf '\xc3\xa9'`) are decoded, and a byte sequence that is not valid UTF-8 becomes U+FFFD | World state is JSON strings; binary data has no use in the scenarios | Do not use the simulator to learn about binary pipelines (`gzip -c`, `base64 -d` of binary) | 02 |
| DIV-003 | bash startup | A login shell reads `/etc/profile` and `~/.profile`, which reads `~/.bashrc`: Ubuntu's defines `ll`, `la`, `l` and `--color=auto` aliases for `ls` and `grep` | No startup file is read yet | They need `if`, `case` and `for` (phase 22a) | `ll` is "command not found"; `ls` and `grep` print no colors | 02 |
| DIV-004 | Commands and time | Every command takes some wall-clock time | A command takes no virtual time unless it waits (`sleep`); files written by successive commands can have the same mtime | Virtual time is deterministic | `ls -t` and `-nt` cannot order files written in the same instant | 02 |
| DIV-006 | Directory order | `readdir` returns entries in the file system's order (hash order on ext4); `ls -U`, `rm -r`, `cp -r`, `chmod -R` and `grep -r` follow it | Name order, `.` and `..` first | The real order is not reproducible | Output of recursive commands lists files in sorted order; golden transcripts avoid depending on it | 02 |
| DIV-007 | Allocated blocks | ext4 allocates in 4 KiB blocks; `ls -s` and the `total` line count them | ceil(size/4096)×8 sectors for a file, 8 for a directory, 0 for a symlink shorter than 60 bytes, 8 otherwise (checked on the workstation) | The VFS has no block allocator | None for ordinary files; sparse files do not exist | 02 |
| DIV-008 | Access and birth times | Files have atime and birth time | Only mtime and ctime | Nothing in the curriculum depends on them | `ls -u`, `touch -a`, `test -N` print a notice | 02 |
| DIV-009 | `grep` matching | glibc's regex engine and Unicode tables | Patterns translated to JavaScript regular expressions; classes and case folding from the JavaScript engine's Unicode tables; a back-reference to a group that did not take part matches empty; `-NUM` given in separate arguments is decided by a heuristic | No regex engine of glibc's in the engine | Exotic Unicode classes and back-references in alternations can differ | 02 |
| DIV-010 | `tail -f` | inotify wakes immediately; tail exits as soon as the reader of its pipe goes away | With one file it wakes on each write; with several files or `-F` it also polls every second; it notices a gone reader at its next write | `ProcApi.wait` takes one topic | Output can lag up to a second with `-F`; `tail -f log \| grep -q x` ends at tail's next write | 02 |
| DIV-011 | Program name in messages | GNU tools name themselves by `argv[0]` as typed (`/usr/bin/sleep: invalid time interval`) | Most programs use the base name (`sleep:`); echo, printf, test and `[` use argv[0] | The helpers in `programs/lib/io.ts` use the base name | Only visible when a command is typed with a path (carry-over in STATUS.md) | 02 |
| DIV-012 | Terminal: paste | bash 5.2 turns on bracketed paste (`ESC[?2004h` before each prompt, readline's enable-bracketed-paste on, `bind -v`): a pasted block lands in the line as one edit and runs only when Enter is pressed | Bracketed paste is not turned on: the terminal sends a paste as typed keys, so each pasted newline runs its line at once, as bash does with enable-bracketed-paste off | The line editor would have to edit and display multi-line pasted buffers; the screens after Enter are the same | A pasted multi-line block runs line by line without waiting for Enter; a pasted line with a mistake runs before it can be fixed | 03 |
| DIV-013 | Line editor | readline implements about 120 bound commands, a kill ring with M-y, undo, keyboard macros and numeric arguments; an edit to a recalled history line stays in the history after Enter (revert-all-at-newline off); `\j` and `\#` in PS1 count jobs and commands | The common commands are implemented (`docs/COVERAGE.md`, Terminal); every other bound command prints a notice; the kill ring holds one entry; edits to recalled history lines are kept only while the line is being edited; `\j` is 0 (no job control) and `\#` equals `\!` | Behavior beyond the common editing keys is rarely used under exam conditions | A rarely used key prints a notice instead of acting | 03 |
| DIV-014 | `vim`, `vi`, `nano` | They draw a full-screen editor on the terminal (alternate screen) | They ask the front end to edit the file: an editor overlay in the web UI (phase 10), the user's own `$EDITOR` in the terminal player; one named file only, no options | A terminal-native vi is out of scope (`PLAN.md` §6.2) | Key bindings come from the overlay or the user's editor, not the real vim; `:!cmd`, `:r !cmd` and multiple buffers do not exist | 03 |
| DIV-015 | API server: `managedFields` | Every write records field ownership per manager in `metadata.managedFields` (`fieldsV1`), which server-side apply uses; `kubectl get -o yaml --show-managed-fields` prints it | Objects have no `managedFields` | Field ownership matters only to server-side apply, which no phase has scheduled yet; kubectl hides the field by default | `--show-managed-fields` shows nothing; conflicts of server-side apply cannot be practiced; the conflict error of `kubectl apply --overwrite=false`, which prints the live object, lacks its managedFields | 05a |
| DIV-016 | API server: Pod updates | A forbidden Pod update is rejected with `spec: Forbidden: pod updates may not change fields other than …` followed by a unified diff of the old and new internal PodSpec (`json.MarshalIndent` with Go field names, go-difflib, 3 lines of context; `apimachinery/pkg/util/diff`) | The first line only | The diff needs the whole internal PodSpec layout and a port of difflib's SequenceMatcher (`apis/core/validation/podspecdiff.ts` holds the stub) | kubectl shows the rejection without the hint of which field changed; the debrief should name it | 05a |
| DIV-017 | API server: warnings in map order | Warnings that `pkg/api/pod/warnings.go` produces by iterating a Go map (several deprecated node labels in one `nodeSelector`) come in random order | Sorted by key; every other warning of warnings.go and `pkg/api/service/warnings.go` is ported, in upstream's order (`fixtures/golden/v1.37.2/api/warnings.yaml`) | Deterministic engine (hard rule 4) | None: the same lines, in a stable order | 05a (narrowed in 07b) |
| DIV-018 | API server: Event lifetime | Events expire after `--event-ttl` (1 h) | Events stay until deleted | No expiry in etcd yet | `kubectl get events` keeps showing old events in long sessions | 05a |
| DIV-019 | Static Pods: config hash | The kubelet names a static Pod's UID and its `kubernetes.io/config.hash`/`config.mirror` annotations with an FNV-128a of the decoded Pod's Go struct dump plus host and file (`pkg/kubelet/config/common.go` applyDefaults) | An FNV-128a of the manifest's JSON with the same host and file | The struct dump needs the internal Pod layout after the kubelet's defaulting (phase 27 builds static Pods for real) | The hash differs from a real node's for the same manifest; it is opaque, and changes when the manifest changes, as the real one does | 06a |
| DIV-020 | Scheduler: scoring | The default profile also scores PodTopologySpread (system default constraints spread a ReplicaSet's or Service's Pods) and InterPodAffinity | Not scored; every other default score plugin is | Topology spread and inter-Pod affinity are phase 20b | Replicas still alternate between workers (least-allocated scoring with the non-zero default requests), but a tie the real scheduler breaks by spread can go another way | 06a |
| DIV-021 | Kubelet: init containers | Init containers run to completion, in order, before the app containers (`PodInitializing`, `Init:0/1`) | A Pod with init containers stays Pending; a gap is recorded | Init containers are phase 16a | Such Pods never start; the gap log says why | 06b |
| DIV-022 | Kubelet: environment | `valueFrom` (ConfigMap, Secret, field and resource references) and `envFrom` resolve into the container's environment | Left out of the environment, with a gap | ConfigMap and Secret projection is phase 16a | A container that reads such a variable sees it unset | 06b |
| DIV-023 | Kubelet: readiness | Probes decide `started` and `ready` (startup, readiness, liveness) | A running container is started and ready at once; probes are not run | Probes are phase 16b | CoreDNS and any Pod with a readiness probe is Ready as soon as it runs | 06b |
| DIV-024 | Kubelet: service variables | The kubelet adds the Services' `*_SERVICE_HOST`/`*_PORT` variables by iterating Go maps, so their order changes between container starts | Sorted by name, after the container's own variables | Deterministic engine (hard rule 4) | `env` lists them in a stable order a real node would not keep | 06b |
| DIV-025 | Runtime: images | Any image a registry serves can be pulled | Only images in the captured catalog (`npm run images:capture`); a tag the registry lacks, an unknown official repository and a reserved domain fail with containerd's real errors; anything else fails with `[sim] image … is not in the simulator's image catalog` and a gap | Nothing really runs: every image needs a file table and behavior models | Learners can use the common images; others say plainly that they are not simulated | 06b |
| DIV-026 | Node health | After 50 s without a Lease renewal the node also gets `node.kubernetes.io/unreachable:NoExecute`, and Pods without a toleration are evicted 300 s later (DefaultTolerationSeconds) | Conditions go Unknown, Pods are marked not ready and the NoSchedule taint is added; no NoExecute taint and no eviction | Evicting without DefaultTolerationSeconds would delete every Pod at once (phase 20b adds both) | Pods on a dead node stay bound to it instead of being replaced after five minutes | 06b |
| DIV-027 | Container logs | The kubelet rotates a container's log at 10 MiB, keeping 5 files (gzip-compressing older ones) | No rotation | No model writes that much | None expected | 06b |
| DIV-028 | Control-plane containers | etcd, kube-apiserver, kube-controller-manager, kube-scheduler, kube-proxy and CoreDNS write their startup and runtime logs | Their containers run a stand-in model with no output | Their real models come with phase 27 (static Pods as processes) and phases 17/30 (kube-proxy, CoreDNS) | `/var/log/pods` files of kube-system Pods are empty | 06b |
| DIV-029 | Containers: filesystem | A container has its image's filesystem plus its volumes; programs read and write files there | Executables are known from the captured file tables; a shell redirection to a file is discarded with a gap; `cat` of a file outside the model is a gap | Container filesystems are phase 16a/17 (volumes, exec) | Scripts that write files (`date >> /log/x`) lose that output | 06b |
| DIV-030 | Container shell | `sh` is the image's real shell with its whole language | dash, BusyBox ash and bash share one interpreter of the common subset (simple commands, `;` `&&` `\|\|` `!`, `{ }` `( )`, while/until/for/if, quoting, `$VAR`, `$(( ))`, `$( )`, traps on signals, `set -e`) checked against the real shells; pipelines, `case`, functions, here-documents and background jobs are gaps, and the container then runs without output | A full shell per container is not needed for the curriculum | Most container commands in CKA/CKAD tasks run; unusual scripts say they are not simulated | 06b |

| DIV-031 | kubectl: YAML and JSON numbers | Integers in objects are int64 and print exactly (`-9223372036854775808`) | Integers beyond 2^53 lose precision (world state holds JSON numbers) | The `Json` type of the engine | None in practice; no Kubernetes field a learner sets needs such numbers | 07a |
| DIV-032 | kubectl: YAML key order | yaml.v2 sorts map keys with a "natural" comparison that is not transitive for some key sets (`"1"`, `"01"`, `"0b101"`), so their order follows Go's random map iteration | Such key sets get one fixed order (Go's insertion sort over byte-sorted keys) | Deterministic engine (hard rule 4) | None in practice; ordinary keys sort as the real tool sorts them | 07a |
| DIV-033 | kubectl: rare Unicode | Go's `%q` and `unicode.IsLetter`/`IsDigit` use Go's Unicode tables | JavaScript's Unicode tables; `%#v` quoting is approximated for rare characters | No port of Go's tables | Only messages quoting unusual characters can differ | 07a |
| DIV-034 | Strategic merge patch | kubectl apply looks patch strategies up in OpenAPI v3; Go map iteration decides which of two errors in one patch is reported, and whether a list or its `$deleteFromPrimitiveList` twin applies first; a JSON number written `1.0` is a float64 | Patch meta from the vendored Go struct tags (same strategies; the lookup's own error texts differ); maps in insertion order; `1.0` is an integer | The vendored schema carries the struct tags; deterministic engine; JSON numbers in the engine (DIV-031) | Only a patch with two errors, or an apply that changes a field the type does not know, reads differently | 07b |
| DIV-035 | kubectl `-f` | Standard input from a terminal is processed document by document as it is typed; UTF-16 manifests (with a BOM) are transcoded; duplicate keys in a JSON List's own `metadata.labels`/`annotations` are rejected (NoDoubleKeySchema) | All of standard input is read before the first request (D-074), so objects print after Ctrl-D; only a UTF-8 BOM is stripped; such duplicates are accepted | Files are read before the first request; file contents are text (DIV-002); the duplicate check was not ported | `kubectl apply -f -` typed at the terminal answers only after Ctrl-D | 07b |
| DIV-036 | kubectl describe: ordering of ties | Go's `sort.Sort` (pdqsort) leaves items with equal keys in an implementation-defined order beyond 12 items (events with the same last-seen second, tolerations with the same key) | A stable sort | Go's pdqsort is not ported yet (carry-over: `src/sort` is now in the checkout) | Only more than 12 events with the same timestamp could list in another order | 07b |

The non-goals in `PLAN.md` §4.3 (no packets, no real cryptography, a bash subset,
an editor overlay instead of a terminal vi, a curated image catalog) become entries when the phase
that builds each area lands, worded for what was actually built.

## 6. The oracle and golden fixtures

The real binaries of the pinned version run on this workstation as a throwaway control plane. Their
output, normalized, is committed as golden fixtures: rank 1 ground truth (§2) for everything the
API server, controllers, scheduler and kubectl print or store. A development tool only: the
platform never runs it, and `npm run check` reads committed fixtures and nothing else.

### 6.1 Running it

```bash
npm run oracle -- fetch     # download and verify the binaries into .upstream/bin/v1.37.2/
npm run oracle -- up        # start a control plane; prints its directory and `export KUBECONFIG=…`
npm run oracle -- status    # every running oracle: directory, server, kubeconfig, processes
npm run oracle -- env [<dir>]               # `export KUBECONFIG=…` of that oracle
npm run oracle -- down [<dir>|--all]        # stop it; exits 1 if any of its processes or ports is left
npm run golden:capture -- [--check] [--jobs N] [case file or directory]
npm run golden:kubectl-manifest -- [--check]
```

- **Binaries** (`tools/src/oracle/binaries.ts`): `kube-apiserver`, `kube-controller-manager`,
  `kube-scheduler`, `kubectl` and `kubeadm` from `dl.k8s.io/release/<tag>/bin/linux/amd64/`
  with their `.sha256` files; etcd from its GitHub release with `SHA256SUMS`, at the version
  kubeadm deploys for the pin (`DefaultEtcdVersion` in the upstream checkout: **v3.7.0** for
  v1.37.2); KWOK **v0.8.0** with the digest from GitHub's release metadata (it publishes no
  checksum file). Digests are pinned in `tools/src/oracle/checksums.json` on first download; a
  later download that differs fails. About 480 MB, git-ignored.
- **Control plane** (`controlplane.ts`): certificates and kubeconfigs from `openssl` (`pki.ts`,
  kubeadm's names: `kubernetes-admin` in group `kubeadm:cluster-admins`, bound to
  `cluster-admin` as `kubeadm init` does); etcd, then the API server with kubeadm's flags, then the
  three Nodes of §6.6, then KWOK, the controller manager and the scheduler, all on 127.0.0.1 and
  ports from 20000–29999 (below the ephemeral and NodePort ranges), as detached process groups
  in a temporary directory. `up` returns once the Nodes are Ready, `default/default` and
  `kube-root-ca.crt` exist and both leader leases are held: about 12 seconds. `down` stops every
  group (SIGTERM, then SIGKILL after 10 s), checks with `kill -0`, `ss` and `pgrep` that no process
  or listener is left, and only then deletes the directory and the state file. Verified on this
  workstation 2026-11-16: every component runs without Docker or root.
- **Several at once.** Each oracle has its own directory (`/tmp/simlab-oracle-XXXXXX`) and its own
  state file, `.upstream/oracle/<directory name>.json`, so oracles of different sessions and
  golden capture's jobs run side by side. `down` and `env` take the oracle's directory (its path,
  its name or its kubeconfig's path); without one they act on the only oracle `up` started and
  refuse when there are several. `down` stops only the processes that oracle's state file lists
  and checks only its ports and directory; `down --all` stops every oracle `up` started, those of
  other sessions included. Golden capture's oracles are recorded with their owner
  (`golden:capture` and its pid); `status` shows them, but `down` and `env` leave them alone unless
  their directory is named.
- **Capture** starts a fresh control plane for every server case (four at a time by default) and
  tears it down after, so no case sees another's objects or events. The 20 initial cases (15
  server, 5 client) take about two minutes.

### 6.2 What each tier can verify

| Tier | Runs | Verifies | Cannot verify |
|---|---|---|---|
| Server oracle | etcd, API server, controller manager, scheduler, kubectl; KWOK as kubelets | Tables, `describe`, `-o yaml/json`, defaulting, validation and admission errors, apply results, controller behavior and events (Deployment, ReplicaSet, node lifecycle, endpoints, service accounts, namespaces), scheduler decisions and `FailedScheduling` messages, kubectl's client errors | Anything a kubelet, container runtime, CNI, kube-proxy or CoreDNS produces: container states and their reasons, Pod events after `Scheduled` (Pulling, Created, Started, BackOff), logs, exec, probes, real Pod IPs. KWOK's stand-ins are marked (§6.5). No kube-system workloads exist (no CoreDNS, kube-proxy or static Pods); a case that needs them creates them |
| Client-only oracle | `kubectl` alone, no kubeconfig unless a case writes one | Help and usage text, `--dry-run=client -o yaml` generators, `kubectl config`, `kubectl kustomize`, the no-server errors, the command and flag manifest | Nothing that needs a server |
| Tier 2 (phase 32) | A kind cluster on a machine with Docker | What the server oracle cannot | — |

### 6.3 Cases

A case is a YAML file under `fixtures/golden/cases/<area>/<name>.yaml`; its fixture is written to
`fixtures/golden/v1.37.2/<area>/<name>.yaml`. The format is checked by `tools/src/golden/case.ts`
(unknown keys fail).

```yaml
description: What the case shows.        # required
server: true                             # false: client-only oracle (default true)
kwok: true                               # default: same as server
files:                                   # written into the working directory = $HOME
  pod.yaml: |
    apiVersion: v1
    ...
setup:                                   # not recorded; each must succeed
  - do: kubectl create -f pod.yaml
  - until: kubectl get events -o name     # poll every 0.5 s until stdout matches
    match: event                          #   (regex), at most `timeout` seconds (default 60)
  - sleep: 1                              # seconds; avoid: prefer until
steps:
  - run: kubectl get pods                # recorded: exit, stdout, stderr
    stdin: "…"                           # optional standard input
    table: get                           # get | describe | none; default from the command
    tty: true                            # run on an 80-column pty (cols: N); records `output`
    kwok: true                           # the output shows fields KWOK wrote (§6.5)
    anyWorker: true                      # placement was a scheduling tie (D-037)
    unorderedLines: true                 # the real tool prints lines in random order
    ageColumns: [4]                      # age columns of a table printed with --no-headers
    normalize: false                     # keep values as captured (help text)
  - do: kubectl wait --for=condition=Ready pod/x   # do, until and sleep may appear among steps
  - objects: [pod/api, -n kube-system lease]       # kubectl get <ref> -o json, normalized
  - request: POST /api/v1/namespaces/default/pods?fieldValidation=Strict   # raw HTTP as the admin
    body: |                              # YAML or JSON, sent as JSON (raw: true sends it verbatim)
      apiVersion: v1
      ...
    contentType: application/merge-patch+json        # for PATCH
    keep: [kind, apiVersion, items]      # keep only these top-level keys of the response
```

A `request` step records the status code, the texts of the `Warning` headers and the normalized
response body: what the API server itself answers, independent of kubectl (D-041). A step with
`keep` records the list too, and the replay keeps the same keys of the simulator's response (used
where a running controller writes fields in the background, as `api/daemonset` does with status). The cases in
`cases/api/` are replayed through the simulator's request pipeline by
`tools/src/golden/api.test.ts`.

Commands run in `/bin/bash --noprofile --norc -c` with `PATH` holding the pinned binaries first,
`HOME` the working directory (with `~/.kube/config` = the admin kubeconfig for a server case),
`LANG=C.UTF-8`, `TZ=UTC`. The fixture holds the case name and description, the versions, the
list of KWOK-authored fields when KWOK ran, and per step what was run with its normalized
results. It has no capture date, so a capture that changed nothing rewrites nothing.

**Adding a case.** Write the file; run `npm run golden:capture -- <file>`; read the fixture
(every volatile value must have become a token, and nothing of the workstation may show:
`golden.test.ts` checks for temporary paths); run `npm run golden:capture -- --check <file>` at
least twice. A difference means the case depends on timing or on a random choice: wait for a
settled state before recording (`do: kubectl rollout status …`, then record), pin placement, or
mark the step. Commit the case and the fixture together.

**What cases must avoid.** Progress output that depends on timing (`kubectl rollout status`
while the rollout runs: record it after `do: kubectl rollout status`); `kubectl diff` (it prints
temporary paths and times); `--watch`; two unschedulable Pods whose retries interleave
(a FailedScheduling count can change); names whose last segment is five letters without vowels
(`-https`), which the suffix rule would take for a generated suffix.

### 6.4 Normalization

`tools/src/golden/normalize.ts`. The token vocabulary is shared with transcripts
(`packages/host/src/transcript/tokens.ts`, `docs/TRANSCRIPTS.md`; D-034):

| Token | Replaces | Rule |
|---|---|---|
| `<<uid:N>>` | Object UIDs | Any RFC 4122 UUID; numbered by first appearance in the fixture |
| `<<time>>` | Timestamps | RFC 3339, RFC 1123 with numeric zone (`describe`), klog headers |
| `<<rv>>` | resourceVersion | The value of a `resourceVersion` key in YAML or JSON |
| `<<age>>` | Ages | Cells of a table column headed AGE, LAST SEEN, FIRST SEEN, DURATION, LAST SCHEDULE or Age (describe's events), `(5s ago)` in RESTARTS, and `ageColumns` |
| `<<ip>>` | Allocated addresses | IPv4 in 10.96.0.0/12 except 10.96.0.1, or in 10.244.0.0/16; worker addresses under `anyWorker`. Node addresses stay |
| `<<hash:N>>` | pod-template-hash, controller-revision-hash | 6–10 characters of `[456789bcdf]` (SafeEncodeString of a decimal uint32) with a letter, after `-` in a name or as a `hash` label's value |
| `<<suffix>>` | generateName's suffix | Five characters of `bcdfghjklmnpqrstvwxz2456789` ending a name after `-` |
| `<<hex>>` | Event name suffixes | `.` and 15–17 hex digits after a name |
| `<<port>>` | Allocated NodePorts | `:3xxxx/TCP`, a `nodePort` value; not when the case file names the number |
| `<<pid>>` | klog's thread id | In a klog header |
| `<<cert>>` | PEM bodies | Between `-----BEGIN …-----` and `-----END` (the cluster CA in `kube-root-ca.crt`) |
| `<<node>>` | A worker chosen by a tie | `node01`/`node02` in steps marked `anyWorker` |

Mappings, applied even with `normalize: false`, so that no workstation detail reaches a fixture:
the working directory becomes `/home/student`; the workstation's host name (in leader election
identities and the scheduler's `reportingInstance`) becomes `controlplane`; `127.0.0.1:<port>` of
the oracle's API server becomes `172.16.0.10:6443` and its port elsewhere `6443`.

Tables (`table: get` or `describe`, by default `kubectl get` without `-o` or with `-o wide` or
custom columns, and `kubectl describe`) are split into cells, normalized per cell and rendered
again with kubectl's tab writer (`tabwriter.ts`, D-035): `get` with minimum width 6 and padding 3
(cells cut at the header's column positions), `describe` with padding 2 (cells split at runs of two
or more spaces; continuation lines and trailing spaces inside a cell are recovered from the
layout). Capture fails when the split does not render back to the captured text. Rows of a `get`
table that hold a `<<suffix>>` or event `<<hex>>` are sorted by their normalized text; in
`describe`, consecutive rows whose suffix-bearing cell is equal are. Objects are normalized as JSON
(the same string rules, plus `resourceVersion` and `nodePort` by key); the items of a list are
sorted by their normalized JSON, and the endpoints of an EndpointSlice by address before that (the
controller writes them in its Pod cache's order, which varies between runs). Hash label values in
JSON (`"pod-template-hash": "557577df75"`) stay as captured: the hash is a function of the Pod
template, the same on every run.

### 6.5 KWOK: not a kubelet

KWOK (`tools/src/oracle/kwok-stages.yaml`, D-036) renews Node leases, writes Node conditions and
moves Pods to Running. It writes what no real kubelet would: a Ready Pod with no `containerID`,
`imageID` or `started`, no `PodReadyToStartContainers` condition, Pod IPs counted from the Node's
CIDR, Node conditions copied from kubelet wording (and `NetworkUnavailable` with reason
`RouteCreated`), a node lease held by KWOK's own identity, and no kubelet events.
A Pod annotated `simlab.dev/kwok-not-ready: "true"` (in a case, or in a Deployment's template) is
moved to Running with Ready and ContainersReady `False` and never becomes ready (the stage
`pod-running-not-ready`): the stand-in for a failing readiness probe, without the `reason` and
`message` a kubelet would give those conditions. Cases use it for not-ready endpoints and stuck
rollouts (`cases/controllers/`). So:

- every fixture of a case with KWOK lists the fields under `kwokAuthored`;
- a step whose output shows any of them carries `kwok: true` (set in the case), and an object of
  kind Pod, Node or Lease gets `kwok: true` automatically;
- a differential test must not assert those fields, or the text rendered from them, as real
  kubelet output. The layout around them (which lines `describe` prints, in which order, the
  columns of `get pods`) is still kubectl's and stays rank 1.

### 6.6 The cluster

Three Nodes as `kubeadm-1cp-2w` defines them (the simulator's `packages/k8s/src/topology/cluster.ts`,
which `tools/src/oracle/topology.ts` turns into KWOK Nodes; D-033, D-055), registered before any
controller starts. The API server advertises 172.16.0.10, so the `kubernetes` Service's endpoint is
the control plane's address. kube-system holds no workloads: no add-on and no static Pod runs, only
what the control plane components create themselves. The simulated topology has them (CoreDNS,
kube-proxy, the control plane's mirror Pods, D-057), so a differential test whose outcome depends on
free capacity removes CoreDNS first (`tools/src/golden/scheduling.test.ts`); the Nodes themselves are
compared in `tools/src/golden/topology.test.ts`.

### 6.7 Client-only oracle and the command manifest

Client cases (`server: false`) run `kubectl` with no kubeconfig unless the case writes one.
Help is captured on an 80-column pseudo-terminal (`tty: true`), because kubectl wraps help text
only when standard output is a terminal (upstream:
`staging/src/k8s.io/kubectl/pkg/util/term/term_writer.go` `GetWordWrapperLimit`).

`npm run golden:kubectl-manifest` walks `kubectl <command> --help` for every command and
subcommand (piped, so unwrapped) and writes `fixtures/golden/v1.37.2/kubectl-commands.json`: for
each command its path, aliases, short description, usage line, subcommands and flags (name,
shorthand, default, a type inferred from how help prints the default, usage, deprecation), plus
`kubectl options`' global flags, and the parts of help that cannot be derived from those fields
(the description, the examples, the root's command groups). 111 commands (the 109 that help lists,
plus `help` and `options`, marked `unlisted`) and 30 global flags for v1.37.2. Hidden and plugin
commands are not in help and not in the manifest. The same run renders every command's help from
the manifest with the simulator's templates (`packages/k8s/src/kubectl/help/`) and compares it
with the binary's, piped and at 79, 80, 100 and 120 columns, plus `kubectl help <cmd>`,
`kubectl options` and `kubectl help nosuch`; `--check` does the same without rewriting, and
`--vendor` writes the engine's copy (`packages/k8s/src/kubectl/data/v1.37.2.ts`) from the fixture
without the binary. The simulated kubectl's command tree, flags and help come from this copy
(docs/decisions.md D-067).

### 6.8 The differential runner

`tools/src/golden/kubectl/` (phase 07a; `npm run golden:diff [-- -v] [case…]` prints the report,
`tools/src/golden/kubectl.test.ts` runs it in the gate; D-072). Every case is replayed in the
simulator: a `kubeadm-1cp-2w` world made to look like the oracle's (kube-system Deployments,
DaemonSets, kube-dns and Pods deleted; for client cases root's kubeconfig removed), forked per
case, with commands typed into a root shell on the control plane in /root and stdout and stderr
redirected to files. Output is normalized with capture's rules (`workdir` /root) and compared
step by step.

- A command the simulated kubectl implements is **compared**. A verb it lacks is run through the
  **shim** (`shim.ts`: the requests real kubectl sends, each cited) when it changes state, so
  later steps see the same cluster, and reported as shimmed with the phase that builds it; a
  read-only one that prints a notice is reported as **notice**; anything else **blocks** the rest
  of the case.
- KWOK-authored fields (§6.5) and the fields of the missing admission plugins (D-046) are masked
  on both sides (`mask.ts`). Numbered tokens are renumbered per step.
- `known.ts` holds the **KNOWN** steps, each with its cause (a DIV entry, an oracle limit, a
  STATUS shortcut); a KNOWN step that passes fails the test. **PENDING** lists differences of work
  in progress and must be empty when a phase ends.
- Describe output is masked by section (D-077): the admission plugins' lines on every Pod, and on
  steps marked `kwok` the KWOK-authored values (written `<<kwok>>` on both sides) and kubelet
  event rows.
- At the end of phase 07a: 197 steps compared, 192 pass, 5 KNOWN, none failing. At the end of
  phase 07b (describe, create, apply and delete simulated; their shim entries gone): 474 steps
  compared, 465 pass, 9 KNOWN (missing `kube-root-ca.crt` ×3, DIV-015 ×4, a KWOK limit, the missing
  Priority admission plugin), none failing; 47 shimmed, 83 notices, 39 blocked (kubeconfig
  writers, KWOK's not-ready device, PriorityClasses).

### 6.9 Known limits

- The workstation resolves `localhost` to `::1` first, so the no-server error reads
  `dial tcp [::1]:8080`. Whether a simulated server prints `[::1]` or `127.0.0.1` depends on its
  `/etc/hosts` (phase 17); not verified against a stock Ubuntu server.
- kubectl's progress lines (`Waiting for deployment … rollout to finish`) and `--watch` output
  are not captured: they depend on timing. Phases that print them take the strings from upstream
  source (rank 2).
- Event aggregation (`(x3 over 5m)`) is captured only where a case makes it deterministic.
- The controller manager runs without a cloud provider and without the kubelets' volume
  plugins; attach-detach, PV provisioning and anything that needs a node agent is out of reach
  until tier 2.
