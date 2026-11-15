# Phase 22b — Shell III: awk, jq, pager

**Milestone** M3 · **Needs** 22a · Follow the session protocol in `CLAUDE.md`.

## Goal

The two small languages I lean on to shape command output, `awk` and `jq`, plus paging through
long output. Each gets a real parser for a documented subset, and an honest notice beyond it.

## Read first

`docs/COVERAGE.md` (shell section). `data/gaps.jsonl` if it exists.

## Build

- **`awk`**: a lexer, parser and interpreter for: field splitting with `-F` and `FS`, `OFS`, `NR`,
  `NF`, `$0` and field assignment; pattern-action rules with regular expression, comparison and
  range patterns; `BEGIN` and `END`; variables and `-v`; arithmetic and string operators;
  `if`/`else`, `for`, `while`; associative arrays with `in` and `delete`; `print` and `printf`;
  `length`, `substr`, `index`, `split`, `sub`, `gsub`, `match`, `tolower`, `toupper`, `sprintf`.
  Unsupported constructs give a `[sim]` notice naming them.
- **`jq`**: a lexer, parser and interpreter for: identity and paths, optional access, array and
  object iteration, slices, pipes and commas, array and object construction, literals, comparison,
  arithmetic, boolean operators and alternative `//`, `if`, `select`, `map`, `map_values`, `keys`,
  `values`, `has`, `length`, `add`, `any`, `all`, `sort`, `sort_by`, `group_by`, `unique`,
  `unique_by`, `min_by`, `max_by`, `first`, `last`, `join`, `split`, `test`, `contains`,
  `startswith`, `endswith`, `ascii_downcase`, `tostring`, `tonumber`, `to_entries`, `from_entries`,
  `with_entries`, `paths` if cheap, `@base64`, `@base64d`, `@csv`, `@tsv`, string interpolation,
  variables with `as`, `--arg`, `--argjson`, `-r`, `-c`, `-e`, `-s`, `-n`, and jq's real output
  formatting and error messages.
- **Pager**: `less` and `more` through the front end (a scrollable overlay in the web app, the real
  pager in the terminal player), used automatically where real tools page (`man` gets a notice,
  `journalctl` will use it in phase 25a).

**Ground truth.** Verify against the real tools on this workstation and freeze results as
transcripts, captured as `docs/FIDELITY.md` §2.1 describes. Both awks are installed: plain `awk`
runs gawk 5.2.1 here, while a stock Ubuntu server's `awk` is mawk 1.3.4 (`/usr/bin/mawk`). Call
each by its full name and note which one a transcript was verified against, since their output can
differ. `jq` 1.7.1 is installed.

## Not in this phase

Full POSIX awk (user functions, `getline`, pipes inside awk) and full jq (`reduce`, `foreach`,
`def`, path expressions, dates) unless the gap log asks for them. Notices cover the rest.

## Exit criteria

- At least forty `awk` and sixty `jq` cases pass, each verified against the real tool, including
  error cases.
- Ten real-world one-liners over `kubectl … -o json` and table output (kept in a test file) work:
  column filters, sums, grouping by node, extracting images, decoding a Secret.
- Notices appear for unsupported constructs and are written to the gap log.
- `docs/COVERAGE.md` regenerated.
