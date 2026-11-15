# tail: last lines and bytes, from-start forms, headers, the obsolete -NUM and +NUM forms, errors.
# Following (-f, -F) never returns to the prompt: it is tested in programs/coreutils/tail.test.ts.
# tags: golden-verified
% printf '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n' > a; printf 'x\ny\nz' > b
$ tail a
3
4
5
6
7
8
9
10
11
12
$ tail -n 2 a b
==> a <==
11
12

==> b <==
y
z (no-eol)
$ tail -n +11 a
11
12
$ tail -n -2 a
11
12
$ tail -n 0 a
$ tail -n +0 a | wc -l
12
$ tail -c 5 a
1
12
$ tail -c +25 a
12
$ tail -c -3 b
y
z (no-eol)
$ tail -3 a
10
11
12
$ tail +11 a
11
12
$ tail -3c a
12
$ tail +3c a
2
3
4
5
6
7
8
9
10
11
12
$ tail -5l a
8
9
10
11
12
$ tail -l a | head -1
3
$ tail + a | head -1
10
$ tail -2b a | wc -c
27
$ tail -q -n1 a b
12
z (no-eol)
$ tail -v -n1 a
==> a <==
12
$ printf '1\n2\n3' | tail -n 2
2
3 (no-eol)
$ printf '1\n2\n3\n' | tail -n 1 -
3
$ tail -n 1 - a < b
==> standard input <==
z
==> a <==
12
$ tail -n 5 -n +11 a
11
12
$ tail -c 2 -n 1 a
12
$ tail -c 2k a | wc -c
27
$ tail -n 2 -- a
11
12
$ echo piped | tail -f
piped
$ tail -n 0 nope; echo "status $?"
status 0
#
# Errors.
$ tail nope a -n1
tail: cannot open 'nope' for reading: No such file or directory
==> a <==
12
[exit 1]
$ tail /tmp
tail: error reading '/tmp': Is a directory
[exit 1]
$ tail -n1 /tmp a
==> /tmp <==
tail: error reading '/tmp': Is a directory

==> a <==
12
[exit 1]
$ tail -n x a
tail: invalid number of lines: ‘x’
[exit 1]
$ tail -n +x a
tail: invalid number of lines: ‘+x’
[exit 1]
$ tail -c x a
tail: invalid number of bytes: ‘x’
[exit 1]
$ tail -c a
tail: invalid number of bytes: ‘a’
[exit 1]
$ tail -n 99999999999999999999999 a
tail: invalid number of lines: ‘99999999999999999999999’: Value too large for defined data type
[exit 1]
$ tail -99999999999999999999999 a
tail: invalid number: ‘-99999999999999999999999’: Numerical result out of range
[exit 1]
$ tail -2 a b
tail: option used in invalid context -- 2
[exit 1]
$ tail a -5
tail: option used in invalid context -- 5
[exit 1]
$ tail -1 -n2 a
tail: option used in invalid context -- 1
[exit 1]
$ tail --follow=bad a
tail: invalid argument ‘bad’ for ‘--follow’
Valid arguments are:
  - ‘descriptor’
  - ‘name’
Try 'tail --help' for more information.
[exit 1]
$ tail -f nope
tail: cannot open 'nope' for reading: No such file or directory
tail: no files remaining
[exit 1]
$ tail -f /tmp
tail: error reading '/tmp': Is a directory
tail: /tmp: cannot follow end of this type of file; giving up on this name
tail: no files remaining
[exit 1]
$ tail -x
tail: invalid option -- 'x'
Try 'tail --help' for more information.
[exit 1]
$ tail --help | head -2
Usage: tail [OPTION]... [FILE]...
Print the last 10 lines of each FILE to standard output.
