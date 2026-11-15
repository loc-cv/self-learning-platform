# grep: -o, -b, -m, context lines and group separators, -Z and -z, binary files, input that is the output.
# tags: golden-verified
% seq 1 20 > n; printf 'foo\nbar\nFoo bar\nbaz\n' > a; printf 'foo\0bar\nfoo2\n' > bin; printf 'a\nb\0\nc\n' > bin2
$ grep -o o a
o
o
o
o
$ grep -on 'o\+' a
1:oo
3:oo
$ grep -ob 'o\+' a
1:oo
9:oo
$ grep -b o a
0:foo
8:Foo bar
$ echo 'abcd' | grep -oE 'a|ab|abc'
abc
$ echo 'xyz abc abcd' | grep -ow 'abc\|abcd'
abc
abcd
$ echo 'ab' | grep -o 'b*'
b
$ echo 'aXbX' | grep -o 'X*'
X
X
$ echo 'aaa' | grep -o '^a'
a
$ echo 'café crème' | grep -ob 'r.'
7:rè
$ grep -o -v zzz a; echo $?
0
$ grep -c -o o a
2
$ printf 'abc' | grep b
abc
$ printf 'abc' | grep -c b
1
$ grep -m1 o a
foo
$ grep -m 2 -c 1 n
2
$ grep -m -1 -c 1 n
11
$ grep -A1 -e 5 -e 9 n
5
6
--
9
10
--
15
16
--
19
20
$ grep -B2 -n '1[05]' n
8-8
9-9
10:10
--
13-13
14-14
15:15
$ grep -C1 -c 5 n
2
$ grep -2 -m1 1 n
1
2
3
$ grep -A1 -m2 1 n
1
2
--
10
11
$ grep -A3 -m1 -e 1 n
1
2
3
4
$ grep -A0 -e 5 -e 9 n
5
--
9
--
15
--
19
$ grep -C1 --group-separator=XX -e 5 -e 9 n
4
5
6
XX
8
9
10
XX
14
15
16
XX
18
19
20
$ grep -C1 --no-group-separator -e 5 -e 9 n
4
5
6
8
9
10
14
15
16
18
19
20
$ grep -A1 5 n a
n:5
n-6
--
n:15
n-16
$ grep -A1 -e 5 -e foo n a
n:5
n-6
--
n:15
n-16
--
a:foo
a-bar
$ grep -v -A1 '[0-8]' n
9
10
$ grep -o -C1 5 n
5
--
5
$ grep -nA1 4 n
4:4
5-5
--
14:14
15-15
$ grep -A 1 -B 0 -n -H 20 n
n:20:20
$ grep -A -1 5 n
grep: -1: invalid context length argument
[exit 2]
$ grep -C 1x 5 n
grep: 1x: invalid context length argument
[exit 2]
$ grep -1n5 foo n a
a:1:foo
a-2-bar
a-3-Foo bar
a-4-baz
$ grep -15 -c 1 n
11
$ grep -Z -l foo a n | cat -v
a^@ (no-eol)
$ grep -Zc foo a n | cat -v
a^@1
n^@0
$ grep -Z -n foo a n | cat -v
a^@1:foo
$ printf 'one\0two\0' | grep -z t | cat -v
two^@ (no-eol)
$ printf 'a\nb\0c\0' | grep -z 'a.b' | cat -v
a
b^@ (no-eol)
# Binary files: a NUL byte, unless -a.
$ grep foo bin
grep: bin: binary file matches
$ grep -c foo bin
2
$ grep -c '^bar' bin
1
$ grep -c . bin
3
$ grep -l foo bin
bin
$ grep -q foo bin; echo $?
0
$ grep -s foo bin; echo $?
grep: bin: binary file matches
0
$ grep -a foo bin | cat -v
foo^@bar
foo2
$ grep --binary-files=text -n bar bin | cat -v
1:foo^@bar
$ grep -I foo bin a; echo $?
a:foo
0
$ grep --binary-files=without-match foo bin
[exit 1]
$ grep -c '' bin2
4
$ grep -n c bin2 a
grep: bin2: binary file matches
$ grep foo bin > /dev/null; echo $?
0
$ cat bin | grep foo
grep: (standard input): binary file matches
$ grep -o oo bin
grep: bin: binary file matches
$ grep -v zzz bin
grep: bin: binary file matches
# Input that is also the output.
$ grep foo a n > out.txt; echo $?; cat out.txt
0
a:foo
$ grep foo a out.txt >> out.txt; echo $?
grep: out.txt: input file is also the output
2
$ grep -c foo a out.txt >> out.txt; echo $?
0
$ grep -m1 foo out.txt >> out.txt; echo $?
0
$ grep -s foo out.txt >> out.txt; echo $?
2
$ grep foo < out.txt >> out.txt; echo $?
grep: (standard input): input file is also the output
2
