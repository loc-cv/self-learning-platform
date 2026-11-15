# cut: fields with delimiters, byte and character lists, complement, output delimiter,
# only-delimited lines, list syntax, errors.
# tags: golden-verified
% printf 'root:x:0:0:root:/root:/bin/bash\nnodelim\na:b\n' > p; printf 'a\tb\tc\n1\t2\n' > tsv
$ cut -d: -f1 p
root
nodelim
a
$ cut -d: -f1,7 p
root:/bin/bash
nodelim
a
$ cut -d: -f3- p
0:0:root:/root:/bin/bash
nodelim

$ cut -d: -f-2 p
root:x
nodelim
a:b
$ cut -d: -f2-3,6 -s p
x:0:/root
b
$ cut -d: --complement -f1 p
x:0:0:root:/root:/bin/bash
nodelim
b
$ cut -d: -f1,3 --output-delimiter=' | ' p
root | 0
nodelim
a
$ cut -d: -f 2,1 p
root:x
nodelim
a:b
$ cut -d: -f '1 3' p
root:0
nodelim
a
$ cut -f2 tsv
b
2
$ cut -f2- --output-delimiter=, tsv
b,c
2
$ cut -c1-4 p
root
node
a:b
$ cut -c -3,5- p
roo:x:0:0:root:/root:/bin/bash
nodlim
a:b
$ cut -b2 p
o
o
:
$ cut -c1-2,4-5 --output-delimiter=: p
ro:t:
no:el
a:
$ cut -c1-3,2-5 --output-delimiter=: p
root:
nodel
a:b
$ cut -b 1 -n p
r
n
a
$ printf 'héllo\n' | cut -c1,4-
hllo
$ printf 'a:b' | cut -d: -f2
b
$ printf 'abc' | cut -c2
b
$ cut -d: -s -f9 p; echo "status $?"


status 0
$ printf 'a:b:c\n' | cut -d: --complement -f2 --output-delimiter=+
a+c
$ cut -d '' -f1 p
root:x:0:0:root:/root:/bin/bash
nodelim
a:b
$ cut -d: -f1 - < p
root
nodelim
a
#
# Errors.
$ cut p
cut: you must specify a list of bytes, characters, or fields
Try 'cut --help' for more information.
[exit 1]
$ cut -f0 p
cut: fields are numbered from 1
Try 'cut --help' for more information.
[exit 1]
$ cut -f ''
cut: fields are numbered from 1
Try 'cut --help' for more information.
[exit 1]
$ cut -f x p
cut: invalid field value ‘x’
Try 'cut --help' for more information.
[exit 1]
$ cut -d: -f1x2 p
cut: invalid field value ‘x2’
Try 'cut --help' for more information.
[exit 1]
$ cut -f 3-1 p
cut: invalid decreasing range
Try 'cut --help' for more information.
[exit 1]
$ cut -f - p
cut: invalid range with no endpoint: -
Try 'cut --help' for more information.
[exit 1]
$ cut -f1,,2 p
cut: fields are numbered from 1
Try 'cut --help' for more information.
[exit 1]
$ cut -c x p
cut: invalid byte/character position ‘x’
Try 'cut --help' for more information.
[exit 1]
$ cut -c0 p
cut: byte/character positions are numbered from 1
Try 'cut --help' for more information.
[exit 1]
$ cut -c 99999999999999999999999 p
cut: byte/character offset ‘99999999999999999999999’ is too large
Try 'cut --help' for more information.
[exit 1]
$ cut -f 99999999999999999999999 p
cut: field number ‘99999999999999999999999’ is too large
Try 'cut --help' for more information.
[exit 1]
$ cut -d ab -f1 p
cut: the delimiter must be a single character
Try 'cut --help' for more information.
[exit 1]
$ cut -d é -f1 p
cut: the delimiter must be a single character
Try 'cut --help' for more information.
[exit 1]
$ cut -c1 -f1 p
cut: only one list may be specified
Try 'cut --help' for more information.
[exit 1]
$ cut -s -c1 p
cut: suppressing non-delimited lines makes sense
	only when operating on fields
Try 'cut --help' for more information.
[exit 1]
$ cut -d: -c1 p
cut: an input delimiter may be specified only when operating on fields
Try 'cut --help' for more information.
[exit 1]
$ cut -f1 nope p
cut: nope: No such file or directory
root:x:0:0:root:/root:/bin/bash
nodelim
a:b
[exit 1]
$ cut -f1 /tmp
cut: /tmp: Is a directory
[exit 1]
$ cut -x
cut: invalid option -- 'x'
Try 'cut --help' for more information.
[exit 1]
$ cut --help | head -2
Usage: cut OPTION... [FILE]...
Print selected parts of lines from each FILE to standard output.
