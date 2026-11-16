# Coverage

What the simulator supports, per area. Anything not listed prints a `[sim]` notice
(`docs/FIDELITY.md` §4) or, for a program the machine does not have, the real "command not found".
Each phase that adds or extends a command updates its section. Verification: **golden** means the
behavior is checked against a capture of the real tool (`docs/TRANSCRIPTS.md`); **source** means
it is written from the man page or upstream source and tested in unit tests. The kubectl section
is generated from the command manifest and the framework's registrations (`npm run
coverage:generate`; a unit test fails when it is stale), so it is never edited by hand.

## Shell (bash 5.2.21)

Started by phase 02 (`packages/host/src/shell/`); transcripts in `packages/host/transcripts/shell/`.

### Grammar and expansion

| Construct | Status | Notes |
|---|---|---|
| Simple commands, `VAR=value cmd`, assignments alone, `name+=value` | golden | assignments before a builtin last for that builtin |
| Pipelines `\|`, `\|&`, `! pipeline` | golden | each stage of a multi-stage pipeline is a subshell process |
| Lists `;`, `&&`, `\|\|`, newlines | golden | |
| `( list )` subshells and `{ list; }` groups, with redirections | golden | |
| Redirections `>`, `>>`, `>\|`, `<`, `<>`, `N>`, `2>&1`, `>&N`, `N<&M`, `N>&-`, `&>`, `&>>` | golden | applied left to right; errors and `ambiguous redirect` as bash prints them |
| Here-documents `<<`, `<<-`, quoted and unquoted delimiters; here-strings `<<<` | golden | also into pipelines |
| Quoting: `'…'`, `"…"`, `\`, `$'…'`, `$"…"` | golden | |
| Comments | golden | |
| `$name`, `${name}`, `${name:-w}`, `${name-w}`, `${name:=w}`, `${name=w}`, `${name:+w}`, `${name+w}`, `${name:?w}`, `${name?w}`, `${#name}` | golden | other `${…}` forms: notice |
| Special parameters `$?`, `$$`, `$#`, `$0`…`$9`, `${10}`, `$@`, `"$@"`, `$*`, `$-` | golden | `$!` is unset (no background jobs) |
| `$RANDOM`, `$SECONDS`, `$LINENO`, `$BASHPID`, `$EPOCHSECONDS`, `$PIPESTATUS` (element 0) | source | `$RANDOM` draws from the PRNG stream `host.bash.random` |
| Command substitution `$(…)` and `` `…` ``, nested | golden | sets `$?` during expansion |
| Tilde expansion `~`, `~/x`, `~user`, after `=` and `:` in assignments | golden | |
| Brace expansion `{a,b}`, `{1..5}`, `{01..03}`, `{a..e}`, `{3..1}`; steps `{1..9..2}` | golden (steps: source) | |
| Word splitting on `IFS` | golden | |
| Pathname expansion `*`, `?`, `[…]`, `[!…]`, POSIX classes | golden | C.UTF-8 order; `globskipdots` on, as in bash 5.2 |
| Aliases, including values ending in a blank, and recursion guards | golden | substituted as each line is parsed, as bash does |
| Initial variables (`BASH`, `BASH_VERSION`, `HOSTNAME`, `SHLVL`, `PWD`, `OLDPWD`, `PS1`, `PS2`, …) | golden | the exported environment is ordered like bash's variable hash table |
| `bash -c CMD [ARG0 ARGS]`, `bash SCRIPT [ARGS]`, `bash -s`, commands from a pipe, scripts with `#!` or without | golden | |
| Syntax errors, `unexpected EOF`, here-document warnings, `-c` and script line numbers | golden | |
| Command not found (127), not executable (126), is a directory (126), bad interpreter (126) | golden | an unknown command is also written to the gap log |
| Exit status of a signal (128 + n); `Terminated`, `Killed`, a newline for SIGINT | source | messages captured from bash 5.2.21 by hand (no `kill` yet to transcript them); `proc/runtime.test.ts` |

Notice instead (`packages/host/transcripts/shell/notices.t`): `if`, `case`, `for`, `while`,
`until`, `select`, functions, `[[ ]]`, `(( ))`, `$(( ))`, `&` (background jobs, job control),
`<( )` and `>( )`, history expansion with `!`, arrays, `time`, `coproc`, and shell options
(`bash -x`, `-e`, …). Startup files are not read yet (DIV-003).

### Builtins

| Builtin | Supported | Notice |
|---|---|---|
| `cd` | `-L`, `-P`, `-e`, `cd`, `cd -`, `HOME`/`OLDPWD` errors | `-@` |
| `pwd` | `-L`, `-P` | |
| `echo` | `-n`, `-e`, `-E`, every `-e` escape | |
| `printf` | `%s %b %q %c %d %i %o %u %x %X %e %E %f %F %g %G %%`, flags, width, precision, `*`, format reuse, `-v` | `%a`, `%A` |
| `export` | `NAME=v`, `NAME`, `-n`, `-p`, no arguments | `-f` |
| `unset` | `NAME`, `-v` | `-f`, `-n` |
| `alias`, `unalias` | listing, defining, `-p`, `-a` | |
| `type` | `-a`, `-t`, `-p`, `-P`; aliases, keywords, builtins, hashed and PATH files | `-f` has nothing to suppress (no functions) |
| `history` | listing, `N`, `-c` | `-d`, `-a`, `-n`, `-r`, `-w`, `-p`, `-s` |
| `source`, `.` | with arguments, PATH lookup | |
| `exit` | status, `logout` on a login shell, errors | |
| `true`, `false`, `:` | | |
| `test`, `[` | every unary and binary operator except `-N`, `-o OPTION` and `-R`; `!`, `-a`, `-o`, `( )`, the POSIX argument-count rules | `-N` (no access time), `-o OPTION`, `-R` |

Every other bash builtin (`read`, `set`, `shopt`, `kill`, `wait`, `exec`, `eval`, `declare`,
`local`, `umask`, `jobs`, …) prints `[sim] bash: the builtin "<name>" is not simulated yet`.

## Terminal (readline 8.2 in bash 5.2.21, Linux n_tty)

Built by phase 03 (`packages/host/src/tty/`). Verification: **golden** means the screen after each
key matches a capture of real bash (`fixtures/reference/bash/readline.json`,
`tty/editor.reference.test.ts`); **source** means written from readline(3), termios(3) or
bash-completion and tested in `tty/terminal.test.ts`.

| Feature | Status | Notes |
|---|---|---|
| Prompt: PS1 and PS2 decoding (`\u \h \H \w \W \s \v \V \$ \d \t \T \@ \A \D{} \n \e \a \[ \] \nnn \!`) and expansion | source | `\j` is 0 and `\#` equals `\!` (DIV-013); the login prompt is Ubuntu .bashrc's (temporary shortcut, D-031) |
| Insert, Left/Right, Home/End (`\e[H \e[F \eOH \eOF`), C-a C-e C-b C-f, M-b M-f | golden | `\e[1~` and `\e[4~` are unbound without an inputrc, as in real bash |
| Backspace, Delete, C-d, C-h, C-u, C-k, C-w, M-d, M-DEL, C-y, C-t, M-. | golden | consecutive kills join in the kill ring, which holds one entry (no M-y) |
| C-l, C-c (status 130), C-d on an empty line (`logout`) | golden | |
| History: Up/Down, C-p C-n, M-< M->, PageUp/PageDown (history-search) | golden | edits to recalled lines are kept while the line is edited (DIV-013) |
| C-r incremental search: extend, repeat, backspace, failed search, C-g, accept, leave with any other key | golden | the match is shown in reverse video |
| Multi-line commands: open quotes and here-documents continue with PS2; recalled from history with their newlines | golden | |
| Wrapping at the terminal width, including a line that ends exactly at the margin; resize | golden (wrapping), source (resize) | |
| Tab: commands (aliases, keywords, builtins, PATH), files, `$VAR`, `${VAR}`, `~user`; quoting of special characters; inside quotes | golden | double Tab lists; 100 or more matches ask `Display all N possibilities? (y or n)`; long lists page with `--More--` |
| Completers: a program's own (`ProgramSpec.complete`); `cd` and `pushd` complete directories | source | bash-completion's other functions are not reproduced yet |
| Canonical input of programs (`cat` reading the terminal): echo, Backspace, C-u, C-w, C-d, C-c | golden | |
| Typeahead during a command | golden | echoed, then run when the prompt returns |
| Ctrl-Z, Ctrl-\\ during a command | — | notice: no job control, no core dumps; at the prompt they do nothing, as in bash |
| Any other bound readline command (undo, M-u, keyboard macros, …) | — | notice under the line; the line is kept |
| Bracketed paste | — | not turned on (DIV-012) |

### Editors

| Program | Status | Notes |
|---|---|---|
| `vim`, `vi`, `view`, `vim.basic`, `vim.tiny`, `nano`, `rnano` on one file | source | through the editor protocol (DIV-014): web overlay, the player's `$EDITOR`, or supplied content; `view` and unwritable files are read-only; a failed save reports vim's `E212` |
| `ex`, `rvim`, `rview`, `vimdiff`, options, several files, no file, a directory | — | notice |

## Programs

Each program's table lists the options it supports; every other real option prints the notice.
Programs not listed exist as executables on the machine (`packages/host/src/base/binaries.ts`)
and print `[sim] <name>: this program is not simulated yet`.

All programs below: options are parsed as glibc's getopt_long does (abbreviations, permutation,
the real usage errors); `--help` prints the real text; `--version` prints the notice unless noted.
Every row is golden-verified unless marked otherwise. Transcripts:
`packages/host/transcripts/<area>/<program>.t`, notices in `<program>-notices.t`.

### Files (coreutils 9.4)

| Program | Supported | Notice |
|---|---|---|
| `ls`, `dir`, `vdir` | columns on a tty (`-C`, `-x`, `-m`, `-1`, `--format`, `-w`, `-T`, `COLUMNS`, `TABSIZE`), one per line in a pipe; `-a -A -B -I --hide -d -R`; `-l -g -o -G -n --author -Z -i -s -k`; `-h --si --block-size` and the `*BLOCK_SIZE` variables; dates (recent, old, future), `--full-time`, `--time-style`, `TIME_STYLE`; `-t -S -X -v -U -f --sort -r --group-directories-first -c --time=ctime`; `-F --classify --file-type -p --indicator-style`; `-L -H`; every quoting style (`-b -Q -N -q --quoting-style`, `QUOTING_STYLE`); `--color` with the built-in colors and `LS_COLORS`; `--hyperlink=never` | `-u`, `--time=atime/birth`, `-D`, `--zero`, active `--hyperlink`; `TZ` other than UTC with `-l` |
| `mkdir` | `-p`, `-m` (octal and symbolic), `-v` | `-Z`, `--context` |
| `touch` | create, `-c`, `-m`, `-f`, `-r`, `-t`, `-d` (ISO-style dates and times, zones `Z`/`UTC`/offsets, `@EPOCH`), `--time=mtime` | `-a` alone and `--time=atime` (no access time), `-h` on a link, other `-d` forms |
| `rm` | `-f`, `-r`/`-R`, `-d`, `-v`, `--interactive=never`, `-I` when it would not ask, `--preserve-root`, `--no-preserve-root`; refusing `.` and `..` | `-i` and every interactive question, `--one-file-system`, `--preserve-root=all` |
| `rmdir` | `-p`, `-v`, `--ignore-fail-on-non-empty` | |
| `chmod` | octal and symbolic modes, comma lists, `-R`, `-v`, `-c`, `-f`, `--reference`, `--preserve-root` | |
| `chown` | `OWNER`, `OWNER:GROUP`, `OWNER:`, `:GROUP`, numeric ids, `-c -v -f -R --from --reference --dereference -H -P`, `-h` on non-links | `-L`, changing a symbolic link itself |
| `ln` | hard and `-s` links, `-t -T -f -n -L -P -d -r -v` | `-b`, `--backup`, `-S`, the `-i` question |
| `cp` | `-r -R -p -a -d -P -L -H --preserve --no-preserve -f -n -u --update -l -s --remove-destination --attributes-only -t -T -v` | the `-i` question, backups, `--parents`, `--reflink`, `--sparse`, `-x`, `--debug`, `-Z` |
| `mv` | `-f -n -u --update -t -T -v --strip-trailing-slashes --no-copy --debug` | the `-i` question, backups, `-Z` |

### Text (coreutils 9.4, GNU grep 3.11)

| Program | Supported | Notice |
|---|---|---|
| `cat` | `-A -b -e -E -n -s -t -T -u -v` | |
| `head` | `-n [-]N`, `-c [-]N` with suffixes, `-q`, `-v`, obsolete `-N` | `-z` |
| `tail` | `-n [+-]N`, `-c [+-]N`, obsolete `-N`/`+N`, `-q`, `-v`, `-f`, `-F`, `--follow=descriptor/name` (source: virtual-time tests) | `--pid`, `-s`, `--retry`, `-z` |
| `wc` | `-l -w -c -m -L`, `--total`, the real column widths | `--files0-from` |
| `sort` | `-b -d -f -g -h -i -M -n -r -V --sort -k -t -u -s -m -o -c -C` | `-R`, `-S`, `-T`, `--parallel`, `--compress-program`, `--debug`, `--files0-from`, `-z` |
| `uniq` | `-c -d -D -u -i -f -s -w --all-repeated --group`, an output operand | `-z` |
| `cut` | `-f -d -s -b -c --complement --output-delimiter -n` | `-z` |
| `tr` | sets, ranges, classes, `[=c=]`, `[c*n]`, escapes, `-d -s -c -C -t` | |
| `tee` | `-a`, `-i`, several files | `-p`, `--output-error` |
| `grep` | BRE, `-E`, `-F`, `-e`, `-f`; `-i -y -v -w -x -m`; `-n -b -H -h --label -o -c -l -L -q -s -Z -z --line-buffered`; `-A -B -C -NUM` and group separators; `--color` and `GREP_COLORS`; `-r -R --include --exclude --exclude-dir --exclude-from`; binary detection on NUL, `-a -I --binary-files`; every glibc regex error | `-P`, `-T`, `-V` |
| `base64` | encode, `-w N`, `-d`, `-i` | |

### Other programs

| Program | Supported | Notice |
|---|---|---|
| `sleep` | `N[smhd]`, fractions, several operands, `infinity`; blocks in virtual time, Ctrl-C ends it | |
| `date` | default format, `+FORMAT` (gnulib's conversions and flags), `-d` (common forms: `@N`, ISO, month names, relative words), `-u -R -I --rfc-3339 -r -f`, `-s` as a user (EPERM) | `--debug`, `--resolution`, `-s` as root, `TZ` other than UTC, rarer `-d` forms |
| `env` | printing, `-i`, `-`, `-u`, `-0`, `-C`, `NAME=VALUE`, running a command through PATH (125, 126, 127) | `-S`, the signal options, `-v` |
| `which` (debianutils 5.17) | `-a`, `-s`, statuses 0, 1, 2 | |
| `clear` (ncurses 6.4) | the 44 ncurses-base terminal types, `-x`, `-T`, `-V` | terminal types outside ncurses-base |
| `seq` | FIRST/INCREMENT/LAST, `-s`, `-w`, `-f`, long-double arithmetic | `%a` |
| `basename`, `dirname` | every option | |
| `whoami`, `id` | `id -u -g -G -n -r -z -a`, a user by name or number | `-Z USER` |
| `hostname` (3.23) | `-s`, `-b`, `-F`, `-y`, `domainname`, `nisdomainname`, `-V` | `-a -A -d -f -i -I`, setting the name as root |
| `echo`, `printf`, `true`, `false`, `pwd`, `test`, `[` (binaries) | as their coreutils versions, which differ from the builtins | `printf %a`, `test -N` |

## Kubernetes API server (v1.37.2)

Started by phase 05a (`packages/k8s/src/apiserver/`, `registry/`, `apis/`). The controllers
(phase 05b), the scheduler and kubelets (06a, 06b) and kubectl (07a) are its clients. Verification: **golden** means the raw API
fixtures (`fixtures/golden/v1.37.2/api/`) are replayed through the pipeline and match the real
server (`tools/src/golden/api.test.ts`, `defaulted.test.ts`); **source** means ported and unit
tested.

| Area | Status | Notes |
|---|---|---|
| Discovery: every resource and subresource the real server serves, verbs, short names, categories | golden | generated from the oracle's discovery documents (D-041) |
| Decoding: unknown fields (Strict, Warn — the default —, Ignore), type errors, quantities, times, base64 | golden | bodies are JSON values: malformed JSON and duplicate keys never reach the server (D-042) |
| create, get, list, update (optimistic concurrency, unconditional, create on update), JSON merge patch, strategic merge patch (merge keys, `$patch`, `$retainKeys`, `$setElementOrder`, `$deleteFromPrimitiveList`), delete | golden | JSON patches and server-side apply: notice |
| generateName, uid, creationTimestamp, generation, resourceVersion, no-op updates | golden | uids and suffixes from named PRNG streams |
| Deletion: grace periods (Pods), finalizers, `orphan`/`foregroundDeletion` from propagation policies, Namespace deletion | golden | |
| Label and field selectors, per-kind field labels | golden | |
| Status subresources | golden | |
| Scale subresource (Deployment, ReplicaSet) | golden (GET) | writes: notice (D-045) |
| Watch: from now, from a past resourceVersion (75 s / 100 events), Expired, selector transitions | source | `apiserver/pipeline.test.ts`; bookmarks are not sent |
| dryRun=All | golden | |
| Admission: NamespaceLifecycle (missing and terminating namespaces, immortal namespaces) | golden | the other default plugins: phase 20b (D-039) |
| Bootstrap: kube-system, kube-public, kube-node-lease, default; the `kubernetes` Service, its ServiceCIDR, IPAddress, Endpoints and EndpointSlice | source | checked against the oracle by hand |
| Kinds with defaulting, validation and registry rules: Namespace, ConfigMap, Secret, ServiceAccount, Node, Pod, Service (ClusterIP and NodePort allocation), Endpoints, EndpointSlice, Event (core and events.k8s.io, one storage), Deployment, ReplicaSet, Lease; IPAddress and ServiceCIDR minimally | golden | every other resource: notice (D-043); unported validation of a used field writes the gap log |
| Warnings (`Warning` headers) of Pods, of the pod templates of Deployments, ReplicaSets and DaemonSets (on create, and on updates that change the generation), and of Services; the recorder's dedupe | golden | `fixtures/golden/cases/api/warnings.yaml`; several deprecated nodeSelector keys warn in sorted order (Go's map order is random); truncation past 4096 runes: source. The other kinds' warnings (Node, Secret, ServiceAccount, Endpoints, EndpointSlice, unknown fields) came with phase 05a |
| managedFields | — | not maintained (DIV-015) |

## kubectl (v1.37.2)

Started by phase 07a (`packages/k8s/src/kubectl/`). Help, usage and `kubectl options` print the
real text for every command, simulated or not (golden). Transcripts in
`packages/k8s/transcripts/kubectl/`; the differential runner (`npm run golden:diff`) replays the
golden cases.

<!-- BEGIN GENERATED kubectl: npm run coverage:generate -->
Generated by `npm run coverage:generate` from the command manifest of kubectl 1.37.2
(`packages/k8s/src/kubectl/data/`), the verbs and global flags registered in `packages/k8s/src/kubectl/kubectl.ts`,
and the API server's discovery registry and strategies. Edit those, not this section.

### Commands

All 111 commands of the real kubectl, in its help's groups: 42 simulated (flags below), 13 print their help as the real ones do (kubectl itself included), 56 print the notice.

| Command | Group | Status | Subcommands |
|---|---|---|---|
| `kubectl` | | help (as the real one) | |
| `create` | Basic Commands (Beginner) | simulated | simulated: `configmap`, `deployment`, `namespace`, `secret generic`, `service clusterip`, `service externalname`, `service loadbalancer`, `service nodeport`, `serviceaccount`; help (as the real one): `secret`, `service`; notice: `clusterrole`, `clusterrolebinding`, `cronjob`, `ingress`, `job`, `poddisruptionbudget`, `priorityclass`, `quota`, `role`, `rolebinding`, `secret docker-registry`, `secret tls`, `token` |
| `expose` | Basic Commands (Beginner) | simulated |  |
| `run` | Basic Commands (Beginner) | simulated |  |
| `set` | Basic Commands (Beginner) | help (as the real one) | simulated: `image`; notice: `env`, `resources`, `selector`, `serviceaccount`, `subject` |
| `explain` | Basic Commands (Intermediate) | simulated |  |
| `get` | Basic Commands (Intermediate) | simulated |  |
| `edit` | Basic Commands (Intermediate) | simulated |  |
| `delete` | Basic Commands (Intermediate) | simulated |  |
| `rollout` | Deploy Commands | help (as the real one) | simulated: `history`, `pause`, `restart`, `resume`, `status`, `undo` |
| `scale` | Deploy Commands | simulated |  |
| `autoscale` | Deploy Commands | notice |  |
| `certificate` | Cluster Management Commands | help (as the real one) | notice: `approve`, `deny` |
| `cluster-info` | Cluster Management Commands | simulated | notice: `dump` |
| `top` | Cluster Management Commands | help (as the real one) | notice: `node`, `pod` |
| `cordon` | Cluster Management Commands | notice |  |
| `uncordon` | Cluster Management Commands | notice |  |
| `drain` | Cluster Management Commands | notice |  |
| `taint` | Cluster Management Commands | notice |  |
| `describe` | Troubleshooting and Debugging Commands | simulated |  |
| `logs` | Troubleshooting and Debugging Commands | simulated |  |
| `attach` | Troubleshooting and Debugging Commands | notice |  |
| `exec` | Troubleshooting and Debugging Commands | notice |  |
| `port-forward` | Troubleshooting and Debugging Commands | notice |  |
| `proxy` | Troubleshooting and Debugging Commands | notice |  |
| `cp` | Troubleshooting and Debugging Commands | notice |  |
| `auth` | Troubleshooting and Debugging Commands | help (as the real one) | notice: `can-i`, `reconcile`, `whoami` |
| `debug` | Troubleshooting and Debugging Commands | notice |  |
| `events` | Troubleshooting and Debugging Commands | notice |  |
| `diff` | Advanced Commands | notice |  |
| `apply` | Advanced Commands | simulated | notice: `edit-last-applied`, `set-last-applied`, `view-last-applied` |
| `patch` | Advanced Commands | notice |  |
| `replace` | Advanced Commands | notice |  |
| `wait` | Advanced Commands | notice |  |
| `kustomize` | Advanced Commands | notice |  |
| `label` | Settings Commands | simulated |  |
| `annotate` | Settings Commands | simulated |  |
| `completion` | Settings Commands | simulated |  |
| `api-resources` | Other Commands | simulated |  |
| `api-versions` | Other Commands | simulated |  |
| `config` | Other Commands | help (as the real one) | simulated: `current-context`, `delete-context`, `get-clusters`, `get-contexts`, `get-users`, `set-context`, `use-context`, `view`; notice: `delete-cluster`, `delete-user`, `rename-context`, `set`, `set-cluster`, `set-credentials`, `unset` |
| `kuberc` | Other Commands | help (as the real one) | notice: `set`, `view` |
| `plugin` | Other Commands | help (as the real one) | notice: `list` |
| `version` | Other Commands | simulated |  |
| `help` | Unlisted | help (as the real one) |  |
| `options` | Unlisted | help (as the real one) |  |

### Flags of the simulated commands

Each command's own flags, in its help's order. Notice: the flag prints the `[sim]` notice and is written to the gap log; no effect: parsed and accepted silently, with the reason (docs/FIDELITY.md §4.1). The global flags follow.

#### `kubectl annotate`

| Status | Flags |
|---|---|
| simulated | `--all`, `--dry-run`, `--field-manager`, `--field-selector`, `--list`, `--local`, `--overwrite`, `-R, --recursive`, `--resource-version`, `-l, --selector` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-A, --all-namespaces` (with -f prints a notice), `-f, --filename` (URLs (http://, https://) print a notice: the simulated machines have no network access), `-k, --kustomize` (prints a notice: kustomize is not simulated), `-o, --output` (kyaml and the template formats print a notice), `--template` (prints a notice: template output is not simulated) |
| accepted, no effect | `--allow-missing-template-keys`: only used by template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl api-resources`

| Status | Flags |
|---|---|
| simulated | `--api-group`, `--categories`, `--namespaced`, `--no-headers`, `--sort-by`, `--verbs` |
| `-o` formats | `json`, `name`, `wide`, `yaml` and the default; notice: `kyaml` |
| notice for some values | `-o, --output` (kyaml prints a notice) |
| accepted, no effect | `--cached`: the discovery cache is not modeled: discovery is answered by the server each time, with the same result; `--show-managed-fields`: an APIResourceList has no managed fields to show or strip |
| notice | — |

#### `kubectl api-versions`

| Status | Flags |
|---|---|
| simulated | — |
| notice | — |

#### `kubectl apply`

| Status | Flags |
|---|---|
| simulated | `--cascade`, `--dry-run`, `--field-manager`, `--overwrite`, `-R, --recursive`, `-l, --selector`, `--validate` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `--all` (only used with --prune, which prints a notice), `-f, --filename` (URLs (http://, https://) print a notice: the simulated machines have no network access), `--force` (replacing an object the patch cannot change prints a notice), `--force-conflicts` (only valid with --server-side, which prints a notice), `-k, --kustomize` (prints a notice: kustomize is not simulated), `--openapi-patch` (the patch strategies come from the built-in Go types either way, which the OpenAPI extensions mirror; false drops the warnings of a failed patch), `-o, --output` (kyaml and the template formats print a notice), `--prune` (prints a notice after the flag checks: pruning is not simulated), `--prune-allowlist` (only used with --prune, which prints a notice), `--server-side` (prints a notice after the flag checks: server-side apply is not simulated), `--subresource` (only valid with --server-side, which prints a notice), `--template` (prints a notice: template output is not simulated) |
| accepted, no effect | `--allow-missing-template-keys`: only used by template output formats, which print a notice; `--grace-period`: only used when --force deletes an object or --prune deletes them, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015); `--timeout`: only used when --force deletes an object, which prints a notice; `--wait`: only used when --prune deletes objects, which prints a notice |
| notice | — |

#### `kubectl cluster-info`

| Status | Flags |
|---|---|
| simulated | — |
| notice | — |

#### `kubectl completion`

| Status | Flags |
|---|---|
| simulated | — |
| notice | — |

#### `kubectl config current-context`

| Status | Flags |
|---|---|
| simulated | — |
| notice | — |

#### `kubectl config delete-context`

| Status | Flags |
|---|---|
| simulated | — |
| notice | — |

#### `kubectl config get-clusters`

| Status | Flags |
|---|---|
| simulated | — |
| notice | — |

#### `kubectl config get-contexts`

| Status | Flags |
|---|---|
| simulated | `--no-headers`, `-o, --output` |
| notice | — |

#### `kubectl config get-users`

| Status | Flags |
|---|---|
| simulated | — |
| notice | — |

#### `kubectl config set-context`

| Status | Flags |
|---|---|
| simulated | `--cluster`, `--current`, `-n, --namespace`, `--user` |
| notice | — |

#### `kubectl config use-context`

| Status | Flags |
|---|---|
| simulated | — |
| notice | — |

#### `kubectl config view`

| Status | Flags |
|---|---|
| simulated | `--flatten`, `--merge`, `--minify`, `--raw` |
| `-o` formats | `json`, `name`, `yaml` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-o, --output` (kyaml, go-template, template and jsonpath formats print a notice), `--template` (go templates print a notice) |
| accepted, no effect | `--allow-missing-template-keys`: templates print a notice; no other printer reads it; `--show-managed-fields`: a kubeconfig has no managed fields to show or strip |
| notice | — |

#### `kubectl create`

| Status | Flags |
|---|---|
| simulated | `--dry-run`, `--field-manager`, `-R, --recursive`, `--save-config`, `-l, --selector`, `--validate` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `--edit` (prints a notice: editing before create is not simulated), `-f, --filename` (URLs (http://, https://) print a notice: the simulated machines have no network access), `-k, --kustomize` (prints a notice: kustomize is not simulated), `-o, --output` (kyaml and the template formats print a notice), `--raw` (prints a notice after its own checks: raw POSTs are not simulated), `--template` (prints a notice: template output is not simulated) |
| accepted, no effect | `--allow-missing-template-keys`: only used by template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015); `--windows-line-endings`: only used with --edit, which prints a notice |
| notice | — |

#### `kubectl create configmap`

| Status | Flags |
|---|---|
| simulated | `--append-hash`, `--dry-run`, `--field-manager`, `--from-env-file`, `--from-file`, `--from-literal`, `--save-config`, `--validate` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-o, --output` (kyaml and the template formats print a notice), `--template` (prints a notice: template output is not simulated) |
| accepted, no effect | `--allow-missing-template-keys`: only used by template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl create deployment`

| Status | Flags |
|---|---|
| simulated | `--dry-run`, `--field-manager`, `--image`, `--port`, `-r, --replicas`, `--save-config`, `--validate` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-o, --output` (kyaml and the template formats print a notice), `--template` (prints a notice: template output is not simulated) |
| accepted, no effect | `--allow-missing-template-keys`: only used by template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl create namespace`

| Status | Flags |
|---|---|
| simulated | `--dry-run`, `--field-manager`, `--save-config`, `--validate` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-o, --output` (kyaml and the template formats print a notice), `--template` (prints a notice: template output is not simulated) |
| accepted, no effect | `--allow-missing-template-keys`: only used by template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl create secret generic`

| Status | Flags |
|---|---|
| simulated | `--append-hash`, `--dry-run`, `--field-manager`, `--from-env-file`, `--from-file`, `--from-literal`, `--save-config`, `--type`, `--validate` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-o, --output` (kyaml and the template formats print a notice), `--template` (prints a notice: template output is not simulated) |
| accepted, no effect | `--allow-missing-template-keys`: only used by template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl create service clusterip`

| Status | Flags |
|---|---|
| simulated | `--clusterip`, `--dry-run`, `--field-manager`, `--save-config`, `--tcp`, `--validate` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-o, --output` (kyaml and the template formats print a notice), `--template` (prints a notice: template output is not simulated) |
| accepted, no effect | `--allow-missing-template-keys`: only used by template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl create service externalname`

| Status | Flags |
|---|---|
| simulated | `--dry-run`, `--external-name`, `--field-manager`, `--save-config`, `--tcp`, `--validate` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-o, --output` (kyaml and the template formats print a notice), `--template` (prints a notice: template output is not simulated) |
| accepted, no effect | `--allow-missing-template-keys`: only used by template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl create service loadbalancer`

| Status | Flags |
|---|---|
| simulated | `--dry-run`, `--field-manager`, `--save-config`, `--tcp`, `--validate` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-o, --output` (kyaml and the template formats print a notice), `--template` (prints a notice: template output is not simulated) |
| accepted, no effect | `--allow-missing-template-keys`: only used by template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl create service nodeport`

| Status | Flags |
|---|---|
| simulated | `--dry-run`, `--field-manager`, `--node-port`, `--save-config`, `--tcp`, `--validate` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-o, --output` (kyaml and the template formats print a notice), `--template` (prints a notice: template output is not simulated) |
| accepted, no effect | `--allow-missing-template-keys`: only used by template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl create serviceaccount`

| Status | Flags |
|---|---|
| simulated | `--dry-run`, `--field-manager`, `--save-config`, `--validate` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-o, --output` (kyaml and the template formats print a notice), `--template` (prints a notice: template output is not simulated) |
| accepted, no effect | `--allow-missing-template-keys`: only used by template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl delete`

| Status | Flags |
|---|---|
| simulated | `--all`, `-A, --all-namespaces`, `--cascade`, `--dry-run`, `--field-selector`, `-f, --filename`, `--force`, `--grace-period`, `--ignore-not-found`, `--now`, `-o, --output`, `-R, --recursive`, `-l, --selector`, `--timeout`, `--wait` |
| notice | `-i, --interactive`, `-k, --kustomize`, `--raw` |

#### `kubectl describe`

| Status | Flags |
|---|---|
| simulated | `-A, --all-namespaces`, `-f, --filename`, `-R, --recursive`, `-l, --selector`, `--show-events` |
| accepted, no effect | `--chunk-size`: lists are answered whole; the printed result is the same |
| notice | `-k, --kustomize` |

#### `kubectl edit`

| Status | Flags |
|---|---|
| simulated | `--field-manager`, `--output-patch`, `-R, --recursive`, `--save-config`, `--validate`, `--windows-line-endings` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-f, --filename` (URLs (http://, https://) print a notice: the simulated machines have no network access), `-k, --kustomize` (prints a notice: kustomize is not simulated), `-o, --output` (kyaml and the template formats print a notice), `--subresource` (only status is simulated; other values print a notice), `--template` (prints a notice: template output is not simulated) |
| accepted, no effect | `--allow-missing-template-keys`: only used by template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl explain`

| Status | Flags |
|---|---|
| simulated | `--api-version`, `--max-depth`, `-R, --recursive` |
| `-o` formats | `plaintext` and the default; notice: `plaintext-openapiv2` |
| notice for some values | `-o, --output` (plaintext-openapiv2 (the OpenAPI v2 renderer)) |
| notice | — |

#### `kubectl expose`

| Status | Flags |
|---|---|
| simulated | `--cluster-ip`, `--dry-run`, `--external-ip`, `--field-manager`, `-l, --labels`, `--load-balancer-ip`, `--name`, `--overrides`, `--port`, `--protocol`, `-R, --recursive`, `--save-config`, `--selector`, `--session-affinity`, `--target-port`, `--type` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-f, --filename` (URLs print a notice: the simulated machines have no network access), `-k, --kustomize` (prints a notice: kustomize is not simulated), `-o, --output` (kyaml and the template formats print a notice), `--override-type` (json with text that is not valid JSON prints a notice (encoding/json syntax errors are not ported)), `--template` (prints a notice: template output is not simulated) |
| accepted, no effect | `--allow-missing-template-keys`: only used by template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl get`

| Status | Flags |
|---|---|
| simulated | `-A, --all-namespaces`, `--field-selector`, `--ignore-not-found`, `-L, --label-columns`, `--no-headers`, `-o, --output`, `-l, --selector`, `--show-kind`, `--show-labels`, `-w, --watch` |
| `-o` formats | `wide`, `json`, `yaml`, `name` and the default; notice: `custom-columns`, `custom-columns-file`, `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `--output-watch-events` (every value), `--server-print` (`--server-print=false`) |
| accepted, no effect | `--allow-missing-template-keys`: only matters to template output formats, which print a notice; `--chunk-size`: lists are paged in chunks; the printed result is the same; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | `-f, --filename`, `-k, --kustomize`, `--raw`, `-R, --recursive`, `--sort-by`, `--subresource`, `--template`, `--watch-only` |

#### `kubectl label`

| Status | Flags |
|---|---|
| simulated | `--all`, `--dry-run`, `--field-manager`, `--field-selector`, `--list`, `--local`, `--overwrite`, `-R, --recursive`, `--resource-version`, `-l, --selector` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-A, --all-namespaces` (with -f prints a notice), `-f, --filename` (URLs (http://, https://) print a notice: the simulated machines have no network access), `-k, --kustomize` (prints a notice: kustomize is not simulated), `-o, --output` (kyaml and the template formats print a notice), `--template` (prints a notice: template output is not simulated) |
| accepted, no effect | `--allow-missing-template-keys`: only used by template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl logs`

| Status | Flags |
|---|---|
| simulated | `--all-containers`, `--all-pods`, `-c, --container`, `-f, --follow`, `--ignore-errors`, `--limit-bytes`, `--max-log-requests`, `--pod-running-timeout`, `--prefix`, `-p, --previous`, `-l, --selector`, `--since`, `--since-time`, `--tail`, `--timestamps` |
| accepted, no effect | `--insecure-skip-tls-verify-backend`: the simulated kubelets serve valid certificates, so skipping their verification changes nothing |
| notice | — |

#### `kubectl rollout history`

| Status | Flags |
|---|---|
| simulated | `-f, --filename`, `-o, --output`, `-R, --recursive`, `--revision`, `-l, --selector` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-k, --kustomize` (every value), `--template` (every value) |
| accepted, no effect | `--allow-missing-template-keys`: only matters to template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl rollout pause`

| Status | Flags |
|---|---|
| simulated | `--field-manager`, `-f, --filename`, `-o, --output`, `-R, --recursive`, `-l, --selector` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-k, --kustomize` (every value), `--template` (every value) |
| accepted, no effect | `--allow-missing-template-keys`: only matters to template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl rollout restart`

| Status | Flags |
|---|---|
| simulated | `--field-manager`, `-f, --filename`, `-o, --output`, `-R, --recursive`, `-l, --selector` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-k, --kustomize` (every value), `--template` (every value) |
| accepted, no effect | `--allow-missing-template-keys`: only matters to template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl rollout resume`

| Status | Flags |
|---|---|
| simulated | `--field-manager`, `-f, --filename`, `-o, --output`, `-R, --recursive`, `-l, --selector` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-k, --kustomize` (every value), `--template` (every value) |
| accepted, no effect | `--allow-missing-template-keys`: only matters to template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl rollout status`

| Status | Flags |
|---|---|
| simulated | `-f, --filename`, `-R, --recursive`, `--revision`, `-l, --selector`, `--timeout`, `-w, --watch` |
| notice for some values | `-k, --kustomize` (every value) |
| notice | — |

#### `kubectl rollout undo`

| Status | Flags |
|---|---|
| simulated | `--dry-run`, `-f, --filename`, `-o, --output`, `-R, --recursive`, `-l, --selector`, `--to-revision` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-k, --kustomize` (every value), `--template` (every value) |
| accepted, no effect | `--allow-missing-template-keys`: only matters to template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl run`

| Status | Flags |
|---|---|
| simulated | `--annotations`, `--cascade`, `--command`, `--dry-run`, `--env`, `--expose`, `--field-manager`, `--image`, `--image-pull-policy`, `-l, --labels`, `--overrides`, `--pod-running-timeout`, `--port`, `--privileged`, `--restart`, `--save-config` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `--attach` (attaching prints a notice (phase 17)), `-o, --output` (kyaml and the template formats print a notice), `--override-type` (json with text that is not valid JSON prints a notice (encoding/json syntax errors are not ported)), `--rm` (needs attaching, which prints a notice (phase 17)), `-i, --stdin` (attaching prints a notice (phase 17)), `--template` (prints a notice: template output is not simulated), `-t, --tty` (attaching prints a notice (phase 17)) |
| accepted, no effect | `--allow-missing-template-keys`: only used by template output formats, which print a notice; `--detach-keys`: only used when attaching (-i, -t, --attach), which prints a notice (phase 17); `--force`: only used by --rm, which needs attaching and prints a notice (phase 17); `--grace-period`: only used by --rm, which needs attaching and prints a notice (phase 17); `-k, --kustomize`: only used by --rm, which needs attaching and prints a notice (phase 17); `--leave-stdin-open`: only used when attaching (-i, -t, --attach), which prints a notice (phase 17); `-q, --quiet`: only used when attaching (-i, -t, --attach), which prints a notice (phase 17); `-R, --recursive`: only used by --rm, which needs attaching and prints a notice (phase 17); `--show-managed-fields`: objects have no managedFields (DIV-015); `--timeout`: only used by --rm, which needs attaching and prints a notice (phase 17); `--wait`: only used by --rm, which needs attaching and prints a notice (phase 17) |
| notice | — |

#### `kubectl scale`

| Status | Flags |
|---|---|
| simulated | `--all`, `--current-replicas`, `--dry-run`, `-R, --recursive`, `--replicas`, `--resource-version`, `-l, --selector`, `--timeout` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-f, --filename` (URLs (http://, https://) print a notice: the simulated machines have no network access), `-k, --kustomize` (prints a notice: kustomize is not simulated), `-o, --output` (kyaml and the template formats print a notice), `--template` (prints a notice: template output is not simulated) |
| accepted, no effect | `--allow-missing-template-keys`: only used by template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl set image`

| Status | Flags |
|---|---|
| simulated | `--all`, `--dry-run`, `--field-manager`, `--local`, `-R, --recursive`, `-l, --selector` |
| `-o` formats | `json`, `yaml`, `name` and the default; notice: `go-template`, `go-template-file`, `jsonpath`, `jsonpath-as-json`, `jsonpath-file`, `kyaml`, `template`, `templatefile` |
| notice for some values | `-f, --filename` (URLs (http://, https://) print a notice: the simulated machines have no network access), `-k, --kustomize` (prints a notice: kustomize is not simulated), `-o, --output` (kyaml and the template formats print a notice), `--template` (prints a notice: template output is not simulated) |
| accepted, no effect | `--allow-missing-template-keys`: only used by template output formats, which print a notice; `--show-managed-fields`: objects have no managedFields (DIV-015) |
| notice | — |

#### `kubectl version`

| Status | Flags |
|---|---|
| simulated | `--client`, `-o, --output` |
| notice | — |

#### Global flags

| Status | Flags |
|---|---|
| simulated | `--cluster`, `--context`, `--kubeconfig`, `-n, --namespace`, `-s, --server`, `--user` |
| accepted, no effect | `--cache-dir`: the discovery cache is not modeled; discovery is answered from the server each time with the same result; `--log-flush-frequency`: kubectl writes its logs unbuffered here; the output is the same; `--request-timeout`: requests are answered in the same instant of virtual time, so no timeout can expire |
| notice | `--as`, `--as-group`, `--as-uid`, `--as-user-extra`, `--certificate-authority`, `--client-certificate`, `--client-key`, `--disable-compression`, `--insecure-skip-tls-verify`, `--kuberc`, `--match-server-version`, `--password`, `--profile`, `--profile-output`, `--proxy-url`, `--tls-server-name`, `--token`, `--username`, `-v, --v`, `--vmodule`, `--warnings-as-errors` |

### Resource types

Every resource the API server serves (discovery, so name resolution and `api-resources` know them all), and whether it has behavior (a registry strategy: defaulting, validation, storage). Requests for the others print the notice (D-043).

| Group/version | With behavior | Notice |
|---|---|---|
| `v1` | `configmaps`, `endpoints`, `events`, `namespaces`, `nodes`, `pods`, `secrets`, `serviceaccounts`, `services` | `bindings`, `componentstatuses`, `limitranges`, `persistentvolumeclaims`, `persistentvolumes`, `podtemplates`, `replicationcontrollers`, `resourcequotas` |
| `apiregistration.k8s.io/v1` | — | `apiservices` |
| `apps/v1` | `daemonsets`, `deployments`, `replicasets` | `controllerrevisions`, `statefulsets` |
| `events.k8s.io/v1` | `events` | — |
| `authentication.k8s.io/v1` | — | `selfsubjectreviews`, `tokenreviews` |
| `authorization.k8s.io/v1` | — | `localsubjectaccessreviews`, `selfsubjectaccessreviews`, `selfsubjectrulesreviews`, `subjectaccessreviews` |
| `autoscaling/v2` | — | `horizontalpodautoscalers` |
| `autoscaling/v1` | — | `horizontalpodautoscalers` |
| `batch/v1` | — | `cronjobs`, `jobs` |
| `certificates.k8s.io/v1` | — | `certificatesigningrequests`, `clustertrustbundles`, `podcertificaterequests` |
| `networking.k8s.io/v1` | `ipaddresses`, `servicecidrs` | `ingressclasses`, `ingresses`, `networkpolicies` |
| `policy/v1` | — | `poddisruptionbudgets` |
| `rbac.authorization.k8s.io/v1` | — | `clusterrolebindings`, `clusterroles`, `rolebindings`, `roles` |
| `storage.k8s.io/v1` | — | `csidrivers`, `csinodes`, `csistoragecapacities`, `storageclasses`, `volumeattachments`, `volumeattributesclasses` |
| `admissionregistration.k8s.io/v1` | — | `mutatingadmissionpolicies`, `mutatingadmissionpolicybindings`, `mutatingwebhookconfigurations`, `validatingadmissionpolicies`, `validatingadmissionpolicybindings`, `validatingwebhookconfigurations` |
| `apiextensions.k8s.io/v1` | — | `customresourcedefinitions` |
| `scheduling.k8s.io/v1` | — | `priorityclasses` |
| `coordination.k8s.io/v1` | `leases` | — |
| `node.k8s.io/v1` | — | `runtimeclasses` |
| `discovery.k8s.io/v1` | `endpointslices` | — |
| `resource.k8s.io/v1` | — | `deviceclasses`, `devicetaintrules`, `resourceclaims`, `resourceclaimtemplates`, `resourceslices` |
| `flowcontrol.apiserver.k8s.io/v1` | — | `flowschemas`, `prioritylevelconfigurations` |
| `storagemigration.k8s.io/v1` | — | `storageversionmigrations` |
<!-- END GENERATED kubectl -->
