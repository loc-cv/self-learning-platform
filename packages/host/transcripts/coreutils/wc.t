# wc: counts, column widths for files, standard input and pipes, totals, errors.
# tags: golden-verified
% printf '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n' > a; printf 'x\ny z\n' > b; printf 'abc' > nonl
% printf 'héllo wörld\tx\n日本語\n' > u
$ wc a
12 12 27 a
$ wc a b
12 12 27 a
 2  3  6 b
14 15 33 total
$ wc -l a b
12 a
 2 b
14 total
$ wc -w b
3 b
$ wc -c a
27 a
$ wc -m u
18 u
$ wc -L u
17 u
$ wc u
 2  4 26 u
$ wc -lwcmL u
 2  4 18 26 17 u
$ wc nonl
0 1 3 nonl
$ wc -L nonl a
 3 nonl
 2 a
 3 total
$ cat a | wc
     12      12      27
$ cat a | wc -l
12
$ cat a | wc -lc
     12      27
$ wc < a
12 12 27
$ wc -l < a
12
$ wc - < a
12 12 27 -
$ wc a - < b
12 12 27 a
 2  3  6 -
14 15 33 total
$ printf '' | wc
      0       0       0
$ printf 'a b\tc\n  d' | wc -w
4
$ printf 'a\u00a0b c\u3000d\x01e \x01 f\u2028g\n' | wc -w
5
$ printf '\ta\n' | wc -L
9
$ printf 'a\nbb\r\n' | wc -L
2
$ printf 'e\u0301\u00ad\u200bx\n日本\U0001F600\n' | wc -L
6
$ wc -l /dev/null a
      0 /dev/null
     12 a
     12 total
$ wc --total=always a
12 12 27 a
12 12 27 total
$ wc --total=only a b
14 15 33
$ wc --total=never a b
12 12 27 a
 2  3  6 b
$ wc --total=al a b
12 12 27 a
 2  3  6 b
14 15 33 total
#
# Errors.
$ wc nope a
wc: nope: No such file or directory
12 12 27 a
12 12 27 total
[exit 1]
$ wc /tmp
wc: /tmp: Is a directory
      0       0       0 /tmp
[exit 1]
$ wc /tmp a
wc: /tmp: Is a directory
      0       0       0 /tmp
     12      12      27 a
     12      12      27 total
[exit 1]
$ wc --total=bad a
wc: invalid argument ‘bad’ for ‘--total’
Valid arguments are:
  - ‘auto’
  - ‘always’
  - ‘only’
  - ‘never’
Try 'wc --help' for more information.
[exit 1]
$ wc --total=a a
wc: ambiguous argument ‘a’ for ‘--total’
Valid arguments are:
  - ‘auto’
  - ‘always’
  - ‘only’
  - ‘never’
Try 'wc --help' for more information.
[exit 1]
$ wc -x
wc: invalid option -- 'x'
Try 'wc --help' for more information.
[exit 1]
$ wc --help | head -3
Usage: wc [OPTION]... [FILE]...
  or:  wc [OPTION]... --files0-from=F
Print newline, word, and byte counts for each FILE, and a total line if
