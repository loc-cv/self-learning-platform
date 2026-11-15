# sort: C.UTF-8 order, keys and field separators, numeric, human, month and version orders,
# unique, stable, reverse, merge, check, output file, errors.
# tags: golden-verified
% printf 'b\nB\na\nA\n_x\n10\n9\n é\nZ\n\n' > mix; printf 'a  zb\nb ya\nc   xc\n' > k
% printf 'root:x:0:0\nbin:x:2:2\ndaemon:x:1:1\nnobody:x:65534:65534\n' > pw
$ sort mix

 é
10
9
A
B
Z
_x
a
b
$ sort -r mix
b
a
_x
Z
B
A
9
10
 é

$ printf 'b\nB\na\nA\n' | sort -f
A
a
B
b
$ printf '10\n9\n-1\n1.5\nabc\n\n 3\n+2\n1e3\n' | sort -n
-1

+2
abc
1e3
1.5
 3
9
10
$ printf '10\n010\n9\n-0\n0\n-\n.5\n0.50\n-.5\n' | sort -n
-.5
-
-0
0
.5
0.50
9
010
10
$ printf '10 b\n9 a\n10 a\n' | sort -k2
10 a
9 a
10 b
$ printf 'x 10\ny 9\nz 10\n' | sort -k2n
y 9
x 10
z 10
$ printf 'x 10\ny 9\nz 10\n' | sort -k2,2n -r
y 9
z 10
x 10
$ printf 'x 10\ny 9\nz 10\n' | sort -k2,2nr -k1,1
x 10
z 10
y 9
$ sort -t: -k3n pw
root:x:0:0
daemon:x:1:1
bin:x:2:2
nobody:x:65534:65534
$ sort -t: -k3,3 pw
root:x:0:0
daemon:x:1:1
bin:x:2:2
nobody:x:65534:65534
$ sort -t : -k 4nr pw | head -2
nobody:x:65534:65534
bin:x:2:2
$ sort -k2.2 k
c   xc
a  zb
b ya
$ sort -k2.2b k
b ya
a  zb
c   xc
$ sort -b -k2.2 k
b ya
a  zb
c   xc
$ sort -k2.1,2.1 k
a  zb
b ya
c   xc
$ printf 'abc\nabd\naac\n' | sort -k1.2
aac
abc
abd
$ printf '  b\na\n c\n' | sort -b
a
  b
 c
$ printf '  b\na\n c\n' | sort
  b
 c
a
$ printf '1K\n2M\n500\n1G\n3k\n0K\n-1K\n1.5K\n' | sort -h
-1K
0K
500
1K
1.5K
3k
2M
1G
$ printf 'jan\nFEB\n  mar\nxyz\ndec\n' | sort -M
xyz
jan
FEB
  mar
dec
$ printf '1e3\nabc\n-inf\nnan\n2\n0x10\n' | sort -g
abc
nan
-inf
2
0x10
1e3
$ printf '1.10\n1.9\n1.0.1\nfoo-1.2.tar.gz\nfoo-1.10.tar.gz\n1.2~rc1\n1.2\n' | sort -V
1.0.1
1.2~rc1
1.2
1.9
1.10
foo-1.2.tar.gz
foo-1.10.tar.gz
$ printf 'a\nb\na\nA\n' | sort -u
A
a
b
$ printf 'a\nb\na\nA\n' | sort -uf
a
b
$ printf 'b 1\na 1\nc 2\n' | sort -u -k2,2
b 1
c 2
$ printf 'b 1\na 1\nc 2\n' | sort -s -k2,2
b 1
a 1
c 2
$ printf 'b 1\na 1\nc 2\n' | sort -k2,2 -r
c 2
b 1
a 1
$ printf 'a-b\nab\na b\n' | sort -d
a b
a-b
ab
$ printf 'a,b,c\na,a,z\n' | sort -t, -k2,2 -k3r
a,a,z
a,b,c
$ printf 'a\tb\na b\n' | sort -t '	' -k2
a b
a	b
$ printf 'c\na\nb' | sort
a
b
c
$ printf '1\n3\n' > s1; printf '2\n4\n' > s2; sort -m s1 s2
1
2
3
4
$ sort s2 s1 --sort=numeric
1
2
3
4
$ printf '3\n1\n2\n' > o; sort -o o o; cat o
1
2
3
$ sort -n -o out s2 s1; cat out
1
2
3
4
#
# Checking order.
$ sort -c s1; echo "status $?"
status 0
$ printf 'b\na\n' > u1; sort -c u1
sort: u1:2: disorder: a
[exit 1]
$ sort -C u1
[exit 1]
$ printf 'a\nb\nb\n' | sort -cu
sort: -:3: disorder: b
[exit 1]
$ printf '3\n1\n' | sort --check=diagnose-first
sort: -:2: disorder: 1
[exit 1]
$ sort --check=quiet u1
[exit 1]
#
# Errors.
$ sort nope s1
sort: cannot read: nope: No such file or directory
[exit 2]
$ sort /tmp
sort: read failed: /tmp: Is a directory
[exit 2]
$ printf 'x\n' > ro; chmod 000 ro; sort ro
sort: cannot read: ro: Permission denied
[exit 2]
$ sort -k0 s1
sort: field number is zero: invalid field specification ‘0’
[exit 2]
$ sort -k1.0 s1
sort: character offset is zero: invalid field specification ‘1.0’
[exit 2]
$ sort -k1,0 s1
sort: field number is zero: invalid field specification ‘1,0’
[exit 2]
$ sort -kx s1
sort: invalid number at field start: invalid count at start of ‘x’
[exit 2]
$ sort -k1x s1
sort: stray character in field spec: invalid field specification ‘1x’
[exit 2]
$ sort -k1,x s1
sort: invalid number after ',': invalid count at start of ‘x’
[exit 2]
$ sort -k 1.x s1
sort: invalid number after '.': invalid count at start of ‘x’
[exit 2]
$ sort -t ab s1
sort: multi-character tab ‘ab’
[exit 2]
$ sort -t '' s1
sort: empty tab
[exit 2]
$ sort -t '\t' s1
sort: multi-character tab ‘\\t’
[exit 2]
$ sort -t: -t, s1
sort: incompatible tabs
[exit 2]
$ sort -n -g s1
sort: options '-gn' are incompatible
[exit 2]
$ sort -nM s1
sort: options '-Mn' are incompatible
[exit 2]
$ sort -k1n,1g s1
sort: options '-gn' are incompatible
[exit 2]
$ sort -c s1 s2
sort: extra operand 's2' not allowed with -c
[exit 2]
$ sort -c -o x s1
sort: options '-co' are incompatible
[exit 2]
$ sort -o x -o y s1
sort: multiple output files specified
[exit 2]
$ sort -o /nonexist/x s1
sort: open failed: /nonexist/x: No such file or directory
[exit 2]
$ sort --check=bad s1
sort: invalid argument ‘bad’ for ‘--check’
Valid arguments are:
  - ‘quiet’, ‘silent’
  - ‘diagnose-first’
Try 'sort --help' for more information.
[exit 1]
$ sort --sort=bad s1
sort: invalid argument ‘bad’ for ‘--sort’
Valid arguments are:
  - ‘general-numeric’
  - ‘human-numeric’
  - ‘month’
  - ‘numeric’
  - ‘random’
  - ‘version’
Try 'sort --help' for more information.
[exit 1]
$ sort -x
sort: invalid option -- 'x'
Try 'sort --help' for more information.
[exit 2]
$ sort --help | head -2
Usage: sort [OPTION]... [FILE]...
  or:  sort [OPTION]... --files0-from=F
