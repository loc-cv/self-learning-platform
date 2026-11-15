# grep: files and standard input, the common flags, file name prefixes, exit statuses and errors.
# tags: golden-verified
% printf 'foo\nbar\nFoo bar\nbaz\n' > a; printf 'x\nfoo again\n' > b; mkdir d; printf 'last line' > c
$ grep foo a
foo
$ grep -i foo a
foo
Foo bar
$ grep -v foo a
bar
Foo bar
baz
$ grep -n o a
1:foo
3:Foo bar
$ grep -c o a b
a:2
b:1
$ grep foo a b
a:foo
b:foo again
$ grep -h foo a b
foo
foo again
$ grep -H foo a
a:foo
$ grep -l foo a b c
a
b
$ grep -L foo a b c
c
$ grep line c
last line
$ printf 'one\ntwo\n' | grep t
two
$ printf 'one\ntwo\n' | grep -H t
(standard input):two
$ printf 'one\ntwo\n' | grep --label=pipe -c -H o
pipe:2
$ grep foo - b < a
(standard input):foo
b:foo again
$ grep -e foo -e baz a
foo
baz
$ grep -x bar a
bar
$ grep -w bar a
bar
Foo bar
$ grep -ivn 'BA' a
1:foo
# Exit statuses: 0 when a line is selected, 1 when none is, 2 on an error.
$ grep zzz a
[exit 1]
$ grep foo nope a
grep: nope: No such file or directory
a:foo
[exit 2]
$ grep -s foo nope a
a:foo
[exit 2]
$ grep -q foo a; echo $?
0
$ grep -q foo nope a; echo $?
grep: nope: No such file or directory
0
$ grep -q zzz nope a; echo $?
grep: nope: No such file or directory
2
$ grep -c zzz a
0
[exit 1]
$ grep -L foo a; echo $?
0
$ grep -L zzz a; echo $?
a
1
$ grep foo d
grep: d: Is a directory
[exit 2]
$ grep foo d a
grep: d: Is a directory
a:foo
[exit 2]
$ grep -c foo d a
grep: d: Is a directory
d:0
a:1
[exit 2]
$ grep -s foo d; echo $?
2
$ grep foo 'a b'
grep: a b: No such file or directory
[exit 2]
$ grep foo < d
grep: (standard input): Is a directory
[exit 2]
$ grep
Usage: grep [OPTION]... PATTERNS [FILE]...
Try 'grep --help' for more information.
[exit 2]
$ grep -Q foo a
grep: invalid option -- 'Q'
Usage: grep [OPTION]... PATTERNS [FILE]...
Try 'grep --help' for more information.
[exit 2]
$ grep -e
grep: option requires an argument -- 'e'
Usage: grep [OPTION]... PATTERNS [FILE]...
Try 'grep --help' for more information.
[exit 2]
$ grep --fi foo a
grep: option '--fi' is ambiguous; possibilities: '--fixed-regexp' '--file' '--files-with-matches' '--files-without-match'
Usage: grep [OPTION]... PATTERNS [FILE]...
Try 'grep --help' for more information.
[exit 2]
$ grep --no foo a
grep: option '--no' is ambiguous; possibilities: '--no-ignore-case' '--no-filename' '--no-group-separator' '--no-messages'
Usage: grep [OPTION]... PATTERNS [FILE]...
Try 'grep --help' for more information.
[exit 2]
$ grep --co foo a
grep: option '--co' is ambiguous; possibilities: '--context' '--color' '--colour' '--count'
Usage: grep [OPTION]... PATTERNS [FILE]...
Try 'grep --help' for more information.
[exit 2]
$ grep -E -F foo a
grep: conflicting matchers specified
[exit 2]
$ grep -A x foo a
grep: x: invalid context length argument
[exit 2]
$ grep -m 1x foo a
grep: invalid max count
[exit 2]
$ grep --binary-files=foo x a
grep: unknown binary-files type
[exit 2]
$ grep -D x foo a
grep: unknown devices method
[exit 2]
$ grep -d foo x a
grep: invalid argument ‘foo’ for ‘--directories’
Valid arguments are:
  - ‘read’
  - ‘recurse’
  - ‘skip’
Usage: grep [OPTION]... PATTERNS [FILE]...
Try 'grep --help' for more information.
[exit 1]
$ grep -d s foo d; echo $?
1
$ grep -y FOO a
foo
Foo bar
$ grep -u -c foo a
grep: warning: --unix-byte-offsets (-u) is obsolete
1
$ grep -m0 foo a nope; echo $?
1
$ grep --help | head -4
Usage: grep [OPTION]... PATTERNS [FILE]...
Search for PATTERNS in each FILE.
Example: grep -i 'hello world' menu.h main.c
PATTERNS can contain multiple patterns separated by newlines.
$ grep --help | tail -3
Report bugs to: bug-grep@gnu.org
GNU grep home page: <https://www.gnu.org/software/grep/>
General help using GNU software: <https://www.gnu.org/gethelp/>
$ grep --color=foo x a | head -2
Usage: grep [OPTION]... PATTERNS [FILE]...
Search for PATTERNS in each FILE.
