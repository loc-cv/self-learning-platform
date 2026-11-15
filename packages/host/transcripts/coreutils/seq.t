# seq: ranges, increments, fixed-point and float operands, -s, -w, -f, errors.
# tags: golden-verified
$ seq 3
1
2
3
$ seq 2 4
2
3
4
$ seq 1 2 7
1
3
5
7
$ seq 5 1; echo $?
0
$ seq 5 -2 1
5
3
1
$ seq -s, 3
1,2,3
$ seq -s ', ' 1 3
1, 2, 3
$ seq -s '' 3
123
$ seq -s '\n' 2
1\n2
$ seq -w 8 10
08
09
10
$ seq -w -1 1
-1
00
01
$ seq -w -10 -9
-10
-09
$ seq -w 1 0.25 1.5
1.00
1.25
1.50
$ seq -w 0.5 0.5 1
0.5
1.0
$ seq -w 1.0 10 | head -3
01.0
02.0
03.0
$ seq -w 010 011
010
011
$ seq 0.5 0.25 1.5
0.50
0.75
1.00
1.25
1.50
$ seq 1 0.1 1.3
1.0
1.1
1.2
1.3
$ seq 0 0.000001 0.000003
0.000000
0.000001
0.000002
0.000003
$ seq 0.1 0.1 0.3
0.1
0.2
0.3
$ seq 1.0 3
1.0
2.0
3.0
$ seq 1.50 2
1.50
$ seq 1. 3
1
2
3
$ seq .5 1
0.5
$ seq -- -3 -1
-3
-2
-1
$ seq -3
$ seq -1.5 1
-1.5
-0.5
0.5
$ seq 1e2 1e2
100
$ seq 1e-1 1e-1 3e-1
0.1
0.2
0.3
$ seq 1 1e1 30
1
11
21
$ seq 0x10 0x12
16
17
18
$ seq +3 +4
3
4
$ seq 010 011
10
11
$ seq 99999999999999999998 99999999999999999999
99999999999999999998
99999999999999999999
$ seq 1.000000000000000000001 1
1.000000000000000000000
$ seq -f '%03g' 3
001
002
003
$ seq -f 'x%.2fy' 1 2
x1.00y
x2.00y
$ seq -f 'a%%b%gc' 1
a%b1c
$ seq -f '%5g|' 2
    1|
    2|
$ seq -f '%-5g|' 2
1    |
2    |
$ seq -f '%e' 1
1.000000e+00
$ seq -f '%.20g' 0.1 0.1
0.1
$ seq -f %G 1e10 1e10
1E+10
$ seq -f '%Lf' 1
1.000000
$ seq -f "%'g" 1000 1000
1000
$ seq -f '%-+08.3f|' 1
+1.000  |
$ seq --format=%.1f --separator=: 1 3
1.0:2.0:3.0
$ seq --equal 9 10
09
10
$ seq 5 inf | head -3
5
6
7
$ seq 1 inf 2
1
$ seq 1 0 2
seq: invalid Zero increment value: ‘0’
Try 'seq --help' for more information.
[exit 1]
$ seq 1 -0 3
seq: invalid Zero increment value: ‘-0’
Try 'seq --help' for more information.
[exit 1]
$ seq a
seq: invalid floating point argument: ‘a’
Try 'seq --help' for more information.
[exit 1]
$ seq 1 a
seq: invalid floating point argument: ‘a’
Try 'seq --help' for more information.
[exit 1]
$ seq 2 ''
seq: invalid floating point argument: ‘’
Try 'seq --help' for more information.
[exit 1]
$ seq '2 '
seq: invalid floating point argument: ‘2 ’
Try 'seq --help' for more information.
[exit 1]
$ seq " 2"
1
2
$ seq nan
seq: invalid ‘not-a-number’ argument: ‘nan’
Try 'seq --help' for more information.
[exit 1]
$ seq 1 2 3 4
seq: extra operand ‘4’
Try 'seq --help' for more information.
[exit 1]
$ seq
seq: missing operand
Try 'seq --help' for more information.
[exit 1]
$ seq 3 -s
seq: invalid floating point argument: ‘-s’
Try 'seq --help' for more information.
[exit 1]
$ seq 9 11 -w
seq: invalid floating point argument: ‘-w’
Try 'seq --help' for more information.
[exit 1]
$ seq 1 4 --
seq: invalid floating point argument: ‘--’
Try 'seq --help' for more information.
[exit 1]
$ seq -x
seq: invalid option -- 'x'
Try 'seq --help' for more information.
[exit 1]
$ seq -f '%d' 3
seq: format ‘%d’ has unknown %d directive
[exit 1]
$ seq -f '%g %g' 1
seq: format ‘%g %g’ has too many % directives
[exit 1]
$ seq -f 'abc' 1
seq: format ‘abc’ has no % directive
[exit 1]
$ seq -f '%%' 1
seq: format ‘%%’ has no % directive
[exit 1]
$ seq -f '%s' 1
seq: format ‘%s’ has unknown %s directive
[exit 1]
$ seq -f '%5' 1
seq: format ‘%5’ ends in %
[exit 1]
$ seq -f '%hg' 1
seq: format ‘%hg’ has unknown %h directive
[exit 1]
$ seq -w -f %g 1 2
seq: format string may not be specified when printing equal width strings
Try 'seq --help' for more information.
[exit 1]
$ seq --help | head -3
Usage: seq [OPTION]... LAST
  or:  seq [OPTION]... FIRST LAST
  or:  seq [OPTION]... FIRST INCREMENT LAST
