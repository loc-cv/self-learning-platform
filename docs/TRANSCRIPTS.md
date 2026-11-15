# Transcripts

Transcript tests are the main specification for commands (`PLAN.md` §12). A transcript is a
readable file: commands as typed at a terminal, and what the terminal shows. Every phase that adds
a command adds transcripts for it. Phase 02 defined the format, the runner and the capture tool.

## Format

```
# cat: files, standard input and errors.        ← header: lines starting with '#'
# tags: golden-verified                          ← read: tags, and `cols: N` (default 80)
% printf 'one\n' > a                             ← setup: runs, output ignored, must succeed
$ cat a nope                                     ← a command
one                                              ← expected output, stdout and stderr as the
cat: nope: No such file or directory               terminal interleaves them
[exit 1]                                         ← the exit status, when it is not 0
# a comment separates steps                      ← blank lines are output, never separators
$ cat <<EOF                                      ← continuation lines start with "> "
> body
> EOF
body
$ printf x
x (no-eol)                                       ← output that does not end in a newline
```

- Expected output is every line up to the next line starting with `$ `, `% ` or `#`, blank lines
  included. Separate steps with comment lines.
- An output line that starts with `$ `, `% `, `> `, `#`, `[exit ` or `\` is written with a leading
  backslash.
- Commands run in order in one interactive login shell (`-bash`) for user `student` on the machine
  `node01`, in a fresh world, in `/home/student`, on an 80-column terminal. State carries over
  between steps. Virtual time advances only as far as each command waits (`sleep 2` takes two
  virtual seconds; everything else takes none).
- The exit status is `$?` after the command; when the shell exits it is the shell's status.

Source: `packages/host/src/transcript/format.ts` (parser and writer), `runner.ts` (fresh world,
one session), `session.ts` (typing a line, running until the prompt returns, collecting output).
Later phases pass their own world to `runTranscript` (a topology instead of one machine).

## Tags

| Tag | Meaning |
|---|---|
| `golden-verified` | The expected output was captured from the real tools on the workstation with `npm run transcript:capture` and must not be edited by hand. The unit's provenance is `golden-verified` (`docs/FIDELITY.md` §3). |
| none | Written from a source (man page, upstream code) or showing simulator behavior, such as `[sim]` notices. Say which in the header. |

A transcript that shows a `[sim]` notice is never golden-verified: the real tool does something.

## Capturing ground truth

```bash
npm run transcript:capture -- packages/host/transcripts/coreutils/cat.t   # write real output
npm run transcript:capture -- --check                                     # compare all, change nothing
```

For each transcript tagged `golden-verified`, `tools/src/transcript/capture.ts` hands the commands
to `tools/src/transcript/pty_capture.py`, which runs them in a real interactive bash on a
pseudo-terminal, the way a login on the simulated host would run them:

- `-bash --noprofile --norc --noediting -i` (a login shell's name, no startup files as in the
  simulator, no readline redraws), umask 022, `TZ=UTC`, `LANG=C.UTF-8` (`docs/decisions.md`
  D-022), `TERM=xterm-256color`, the environment cleared and rebuilt as the simulated login's;
- a temporary home directory, mapped back to `/home/student` in the output, and the workstation's
  user, group and host names mapped to `student` and `node01`;
- echo off, empty `PS1` and `PS2`, and a `PROMPT_COMMAND` that prints a sentinel carrying `$?`, so
  the output between two sentinels is exactly one command's;
- SIGPIPE restored to its default (Python ignores it, and an ignored signal survives exec).

Things the capture cannot reproduce, and how transcripts avoid them:

- **Time.** The real commands run now; the simulator's clock starts at 2026-11-13T09:00:00Z. Set
  the times that output shows (`touch -d`, `date -d`), or test the behavior in a unit test in
  virtual time.
- **Root.** The capture runs as the workstation user. Behavior that needs root or a second user
  is tested with unit tests that cite the man page or upstream source.
- **The machine's contents.** The workstation is not an Ubuntu server (`docs/FIDELITY.md` §2.1):
  build test trees in the home directory instead of listing `/usr/bin` or reading `/etc/os-release`.
- **Input from the terminal.** A command that waits for terminal input hangs the capture.
- **Inode numbers, pids,** and anything else allocated by the kernel.
