// grep's command line: the option table and the help text.
//   docs: grep --help and grep(1) of grep 3.11
//   upstream: grep 3.11 src/grep.c long_options (its order is the order glibc lists the candidates
//             of an ambiguous abbreviation in), short_options
//   reference: grep 3.11, captured 2026-11-16 (packages/host/transcripts/grep/options.t)

import type { OptionSpec } from '../lib/getopt.ts';

/** `grep --help`. reference: grep 3.11, captured 2026-11-16 */
export const HELP = "Usage: grep [OPTION]... PATTERNS [FILE]...\nSearch for PATTERNS in each FILE.\nExample: grep -i 'hello world' menu.h main.c\nPATTERNS can contain multiple patterns separated by newlines.\n\nPattern selection and interpretation:\n  -E, --extended-regexp     PATTERNS are extended regular expressions\n  -F, --fixed-strings       PATTERNS are strings\n  -G, --basic-regexp        PATTERNS are basic regular expressions\n  -P, --perl-regexp         PATTERNS are Perl regular expressions\n  -e, --regexp=PATTERNS     use PATTERNS for matching\n  -f, --file=FILE           take PATTERNS from FILE\n  -i, --ignore-case         ignore case distinctions in patterns and data\n      --no-ignore-case      do not ignore case distinctions (default)\n  -w, --word-regexp         match only whole words\n  -x, --line-regexp         match only whole lines\n  -z, --null-data           a data line ends in 0 byte, not newline\n\nMiscellaneous:\n  -s, --no-messages         suppress error messages\n  -v, --invert-match        select non-matching lines\n  -V, --version             display version information and exit\n      --help                display this help text and exit\n\nOutput control:\n  -m, --max-count=NUM       stop after NUM selected lines\n  -b, --byte-offset         print the byte offset with output lines\n  -n, --line-number         print line number with output lines\n      --line-buffered       flush output on every line\n  -H, --with-filename       print file name with output lines\n  -h, --no-filename         suppress the file name prefix on output\n      --label=LABEL         use LABEL as the standard input file name prefix\n  -o, --only-matching       show only nonempty parts of lines that match\n  -q, --quiet, --silent     suppress all normal output\n      --binary-files=TYPE   assume that binary files are TYPE;\n                            TYPE is 'binary', 'text', or 'without-match'\n  -a, --text                equivalent to --binary-files=text\n  -I                        equivalent to --binary-files=without-match\n  -d, --directories=ACTION  how to handle directories;\n                            ACTION is 'read', 'recurse', or 'skip'\n  -D, --devices=ACTION      how to handle devices, FIFOs and sockets;\n                            ACTION is 'read' or 'skip'\n  -r, --recursive           like --directories=recurse\n  -R, --dereference-recursive  likewise, but follow all symlinks\n      --include=GLOB        search only files that match GLOB (a file pattern)\n      --exclude=GLOB        skip files that match GLOB\n      --exclude-from=FILE   skip files that match any file pattern from FILE\n      --exclude-dir=GLOB    skip directories that match GLOB\n  -L, --files-without-match  print only names of FILEs with no selected lines\n  -l, --files-with-matches  print only names of FILEs with selected lines\n  -c, --count               print only a count of selected lines per FILE\n  -T, --initial-tab         make tabs line up (if needed)\n  -Z, --null                print 0 byte after FILE name\n\nContext control:\n  -B, --before-context=NUM  print NUM lines of leading context\n  -A, --after-context=NUM   print NUM lines of trailing context\n  -C, --context=NUM         print NUM lines of output context\n  -NUM                      same as --context=NUM\n      --group-separator=SEP  print SEP on line between matches with context\n      --no-group-separator  do not print separator for matches with context\n      --color[=WHEN],\n      --colour[=WHEN]       use markers to highlight the matching strings;\n                            WHEN is 'always', 'never', or 'auto'\n  -U, --binary              do not strip CR characters at EOL (MSDOS/Windows)\n\nWhen FILE is '-', read standard input.  With no FILE, read '.' if\nrecursive, '-' otherwise.  With fewer than two FILEs, assume -h.\nExit status is 0 if any line is selected, 1 otherwise;\nif any error occurs and -q is not given, the exit status is 2.\n\nReport bugs to: bug-grep@gnu.org\nGNU grep home page: <https://www.gnu.org/software/grep/>\nGeneral help using GNU software: <https://www.gnu.org/gethelp/>\n";

/** Printed with glibc's message for a usage error, and alone when no pattern is given. */
export const USAGE = "Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n";

const DIGITS: OptionSpec[] = [...'0123456789'].map((d) => ({ short: d, id: 'digit' }));

export const OPTIONS: OptionSpec[] = [
  { long: 'basic-regexp', short: 'G' },
  { long: 'extended-regexp', short: 'E' },
  // Undocumented alias of --fixed-strings.
  { long: 'fixed-regexp', id: 'fixed-strings' },
  { long: 'fixed-strings', short: 'F' },
  { long: 'perl-regexp', short: 'P', supported: false },
  { long: 'after-context', short: 'A', arg: 'required' },
  { long: 'before-context', short: 'B', arg: 'required' },
  { long: 'binary-files', arg: 'required' },
  { long: 'byte-offset', short: 'b' },
  { long: 'context', short: 'C', arg: 'required' },
  { long: 'color', arg: 'optional' },
  { long: 'colour', id: 'color', arg: 'optional' },
  { long: 'count', short: 'c' },
  { long: 'devices', short: 'D', arg: 'required' },
  { long: 'directories', short: 'd', arg: 'required' },
  { long: 'dereference-recursive', short: 'R' },
  { long: 'exclude', arg: 'required' },
  { long: 'exclude-from', arg: 'required' },
  { long: 'exclude-dir', arg: 'required' },
  { long: 'file', short: 'f', arg: 'required' },
  { long: 'files-with-matches', short: 'l' },
  { long: 'files-without-match', short: 'L' },
  { long: 'group-separator', arg: 'required' },
  { long: 'help' },
  { long: 'include', arg: 'required' },
  { long: 'ignore-case', short: 'i' },
  { long: 'no-ignore-case' },
  // -T pads the prefix to widths that depend on the input; not simulated.
  { long: 'initial-tab', short: 'T', supported: false },
  { long: 'label', arg: 'required' },
  { long: 'line-buffered' },
  { long: 'line-number', short: 'n' },
  { long: 'line-regexp', short: 'x' },
  { long: 'max-count', short: 'm', arg: 'required' },
  { long: 'no-filename', short: 'h' },
  { long: 'no-group-separator' },
  { long: 'no-messages', short: 's' },
  { long: 'null', short: 'Z' },
  { long: 'null-data', short: 'z' },
  { long: 'only-matching', short: 'o' },
  { long: 'quiet', short: 'q' },
  { long: 'recursive', short: 'r' },
  { long: 'regexp', short: 'e', arg: 'required' },
  { long: 'invert-match', short: 'v' },
  { long: 'silent', id: 'quiet' },
  { long: 'text', short: 'a' },
  { long: 'binary', short: 'U' },
  { long: 'unix-byte-offsets', short: 'u' },
  { long: 'version', short: 'V' },
  { long: 'with-filename', short: 'H' },
  { long: 'word-regexp', short: 'w' },
  { short: 'I', id: 'I' },
  // -y: an obsolete synonym of -i.
  { short: 'y', id: 'ignore-case' },
  // -X MATCHER: undocumented matcher selection.
  { short: 'X', id: 'X', arg: 'required', supported: false },
  ...DIGITS,
];
