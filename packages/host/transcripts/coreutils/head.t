# head: line and byte counts, all-but-the-last forms, headers, the obsolete -NUM form, errors.
# tags: golden-verified
% printf '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n' > a; printf 'x\ny\nz' > b
$ head a
1
2
3
4
5
6
7
8
9
10
$ head -n 3 a
1
2
3
$ head -n 2 a b
==> a <==
1
2

==> b <==
x
y
$ head -n -10 a
1
2
$ head -n +2 a
1
2
$ head -c 5 a
1
2
3 (no-eol)
$ head -c -20 a
1
2
3
4 (no-eol)
$ head --bytes=-2 b
x
y (no-eol)
$ head -3 a
1
2
3
$ head -2c a
1
$ head -5q a b
1
2
3
4
5
x
y
z (no-eol)
$ head -q -n1 a b
1
x
$ head -v -n1 a
==> a <==
1
$ head -v -q -n1 a b
1
x
$ head -n 1 - < a
1
$ head -n1 a - b < a
==> a <==
1

==> standard input <==
1

==> b <==
x
$ printf 'abc' | head -n 1
abc (no-eol)
$ printf 'a\nb' | head -n -1
a
$ cat a b | head -n 2
1
2
$ head -n 2k a | tail -n 1
12
$ head -c 1KiB a | wc -l
12
$ head -n0 a; echo "status $?"
status 0
$ head -n -0 b
x
y
z (no-eol)
$ head -n " 3" a
1
2
3
$ printf 'caf\xc3\xa9\n' | head -c 4
caf� (no-eol)
#
# Errors.
$ head nope a -n1
head: cannot open 'nope' for reading: No such file or directory
==> a <==
1
[exit 1]
$ head /tmp
head: error reading '/tmp': Is a directory
[exit 1]
$ head -n 1 /tmp a
==> /tmp <==
head: error reading '/tmp': Is a directory

==> a <==
1
[exit 1]
$ head -n x a
head: invalid number of lines: ‘x’
[exit 1]
$ head -c 1.5 a
head: invalid number of bytes: ‘1.5’
[exit 1]
$ head -n -x a
head: invalid number of lines: ‘x’
[exit 1]
$ head -n "" a
head: invalid number of lines: ‘’
[exit 1]
$ head -n 1x a
head: invalid number of lines: ‘1x’
[exit 1]
$ head -n 99999999999999999999999 a
head: invalid number of lines: ‘99999999999999999999999’: Value too large for defined data type
[exit 1]
$ head -n 1Q a
head: invalid number of lines: ‘1Q’: Value too large for defined data type
[exit 1]
$ head a -5
head: invalid trailing option -- 5
Try 'head --help' for more information.
[exit 1]
$ head -2x a
head: invalid trailing option -- x
Try 'head --help' for more information.
[exit 1]
$ head -n
head: option requires an argument -- 'n'
Try 'head --help' for more information.
[exit 1]
$ head -q3 a
head: invalid trailing option -- 3
Try 'head --help' for more information.
[exit 1]
$ head --x
head: unrecognized option '--x'
Try 'head --help' for more information.
[exit 1]
$ head --help | head -2
Usage: head [OPTION]... [FILE]...
Print the first 10 lines of each FILE to standard output.
