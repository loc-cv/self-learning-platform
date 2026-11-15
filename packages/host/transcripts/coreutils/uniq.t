# uniq: adjacent duplicates, counts, repeated and unique lines, case folding, skipping fields and
# characters, groups, the output operand, errors.
# tags: golden-verified
% printf 'a\na\nb\nA\na\nc\nc\nc\n' > q; printf '1 x a\n2 x a\n3 y a\n' > fq
$ uniq q
a
b
A
a
c
$ uniq -c q
      2 a
      1 b
      1 A
      1 a
      3 c
$ uniq -d q
a
c
$ uniq -u q
b
A
a
$ uniq -i q
a
b
A
c
$ uniq -ci q
      2 a
      1 b
      2 A
      3 c
$ uniq -D q
a
a
c
c
c
$ uniq -dc q
      2 a
      3 c
$ uniq -du q; echo "status $?"
status 0
$ uniq -f1 fq
1 x a
3 y a
$ uniq -f2 -c fq
      3 1 x a
$ uniq -s2 fq
1 x a
3 y a
$ uniq -w1 q
a
b
A
a
c
$ uniq -s1 -w2 fq
1 x a
3 y a
$ uniq +1 q
a
$ uniq --all-repeated=separate q
a
a

c
c
c
$ uniq --all-repeated=prepend q

a
a

c
c
c
$ uniq --group q
a
a

b

A

a

c
c
c
$ uniq --group=append fq
1 x a

2 x a

3 y a

$ uniq --group=prepend -i q

a
a

b

A
a

c
c
c
$ uniq --group=both fq

1 x a

2 x a

3 y a

$ printf 'a\na' | uniq -c
      2 a
$ printf 'a\na' | uniq
a
$ sort q | uniq -c
      1 A
      3 a
      1 b
      3 c
$ uniq q out; cat out
a
b
A
a
c
$ uniq - < q | head -2
a
b
$ uniq -w 99999999999999999999 q | head -1
a
#
# Errors.
$ uniq nope
uniq: nope: No such file or directory
[exit 1]
$ uniq /tmp
uniq: error reading '/tmp': Is a directory
[exit 1]
$ uniq a b c
uniq: extra operand ‘c’
Try 'uniq --help' for more information.
[exit 1]
$ uniq -f x q
uniq: x: invalid number of fields to skip
[exit 1]
$ uniq -s -1 q
uniq: -1: invalid number of bytes to skip
[exit 1]
$ uniq -w x q
uniq: x: invalid number of bytes to compare
[exit 1]
$ uniq --group -c q
uniq: --group is mutually exclusive with -c/-d/-D/-u
Try 'uniq --help' for more information.
[exit 1]
$ uniq -D -c q
uniq: printing all duplicated lines and repeat counts is meaningless
Try 'uniq --help' for more information.
[exit 1]
$ uniq --all-repeated=x q
uniq: invalid argument ‘x’ for ‘--all-repeated’
Valid arguments are:
  - ‘none’
  - ‘prepend’
  - ‘separate’
Try 'uniq --help' for more information.
[exit 1]
$ uniq -x
uniq: invalid option -- 'x'
Try 'uniq --help' for more information.
[exit 1]
$ uniq --help | head -2
Usage: uniq [OPTION]... [INPUT [OUTPUT]]
Filter adjacent matching lines from INPUT (or standard input),
