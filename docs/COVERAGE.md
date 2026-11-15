# Coverage

What the simulator supports, per area. Anything not listed prints a `[sim]` notice
(`docs/FIDELITY.md` §4) or, for a program the machine does not have, the real "command not found".
Each phase that adds or extends a command updates its section. Verification: **golden** means the
behavior is checked against a capture of the real tool (`docs/TRANSCRIPTS.md`); **source** means
it is written from the man page or upstream source and tested in unit tests.

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
