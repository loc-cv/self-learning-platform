# Phase 22a — Shell II: control flow, sed, find, xargs and friends

**Milestone** M3 · **Needs** 03 · Can run any time after phase 03 · Follow the session protocol in `CLAUDE.md`.

## Goal

Close the gap between the simulated shell and how I really work: loops over resources, small
scripts, `sed`, `xargs`, `find`, `watch`. Check the gap log first; what I actually typed and didn't
get decides the priorities.

## Read first

`docs/COVERAGE.md` (shell section). `data/gaps.jsonl` if it exists.

## Build

- **Control flow**: `for` (list and C-style), `while`, `until`, `if`/`elif`/`else`, `case`,
  functions, arithmetic expansion `$(( ))`, brace expansion, `[[ ]]`, parameter expansion forms in
  common use (`${v#…}`, `${v%…}`, `${v/…/…}`, `${#v}`), arrays in simple form, subshells and groups,
  `&` with `wait` and `jobs` in simple form, `set -e`, `-u`, `-x`, `-o pipefail`, `read`, `shift`,
  positional parameters, `trap` as a notice, running a script file with a shebang or `bash file`.
- **Text and file tools**: `sed` (substitute with flags, addresses and ranges, delete, print,
  insert, append, change, `-n`, `-i`, `-E`, several `-e`), `xargs` (`-n`, `-I`, `-r`, `-0`), `find`
  (name, iname, type, mtime, size, maxdepth, `-exec`, `-delete`, `-print0`), `diff` (`-u`, `-q`,
  `-r`), `tac`, `rev`, `nl`, `column -t`, `paste`, `comm`, `stat`, `du`, `df`, `file`, `md5sum`,
  `sha256sum`, `tar` and `gzip` in the forms used for backups, `time`, `timeout`, `yes`.
- **`watch`** (`-n`, `-d` optional), redrawing in virtual time and stopping on Ctrl-C.
- **Shell comforts**: `PS1`, `~/.bashrc` sourced at login (so aliases and `export do=…` persist
  within a lab), `!!` and `!$` history expansion, `Ctrl-Z` gets a notice.

**Ground truth.** Verify every tool against the real one on this workstation and freeze the results
as transcripts. Capture in the clean bash from `docs/FIDELITY.md` §2.1: in your own shell `find`
runs bfs, `grep` runs ugrep and `diff` adds color. For `sed`, implement a real parser for the
supported subset and give a `[sim]` notice that names an unsupported command.

## Not in this phase

`awk`, `jq`, pagers (phase 22b). `systemctl`, `journalctl`, `ss`, `ip`, `ps` and other node tools
(phase 25a). A terminal-native vi.

## Exit criteria

- Each tool has transcripts for its common uses, verified against the real tool, plus notices for
  unsupported constructs.
- A multi-line script with functions, a loop, a `case` and `set -euo pipefail` runs from a file and
  matches real bash output, including where it stops on the first error.
- Ten real-world one-liners I'd use with kubectl (kept in a test file) all work: loops over
  namespaces, `sed -i` on a manifest, `xargs` deletes, `watch kubectl get pods`.
- `docs/COVERAGE.md` regenerated.
