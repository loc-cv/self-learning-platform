# The coreutils test and [ binaries (env test, /usr/bin/[): strings, integers, files, -a/-o,
# parentheses, and their syntax errors.
# tags: golden-verified
% printf 'x\n' > file; : > empty; ln -s file link; mkdir dir
$ env test; echo $?
1
$ env test a; echo $?; env test ''; echo $?; env test -n; echo $?; env test -x; echo $?
0
1
0
0
$ env test -z ''; echo $?; env test -n ''; echo $?
0
1
$ env test a = a; echo $?; env test a == b; echo $?; env test a != b; echo $?; env test = = =; echo $?
0
1
0
0
$ env test 1 -eq 1; echo $?; env test 2 -lt 10; echo $?; env test 10 -le 9; echo $?
0
0
1
$ env test " 1 " -eq 1; echo $?; env test +1 -eq 1; echo $?; env test -1 -ge -2; echo $?
0
0
0
$ env test 99999999999999999999 -gt 1; echo $?
0
$ env test -l abc -eq 3; echo $?; env test 2 -eq -l ab; echo $?
0
0
$ env test -e file; echo $?; env test -e nope; echo $?; env test -f file; echo $?; env test -f dir; echo $?
0
1
0
1
$ env test -d dir; echo $?; env test -s file; echo $?; env test -s empty; echo $?
0
0
1
$ env test -L link; echo $?; env test -h file; echo $?; env test -r file; echo $?; env test -w /etc/passwd; echo $?
0
1
0
1
$ env test -x /bin/ls; echo $?; env test -c /dev/null; echo $?; env test -O file; echo $?; env test -G file; echo $?
0
0
0
0
$ env test -u /bin/ls; echo $?; env test -k /tmp; echo $?; env test -p file; echo $?; env test -S file; echo $?; env test -b file; echo $?
1
0
1
1
1
$ env test file -ef link; echo $?; env test file -ef empty; echo $?; env test nope -nt file; echo $?; env test file -nt nope; echo $?
0
1
1
0
$ env test -t 1; echo $?; env test -t 1 > /dev/null; echo $?
0
1
$ env test ! a; echo $?; env test ! ''; echo $?; env test ! ! a; echo $?
1
0
0
$ env test a -a ''; echo $?; env test '' -o a; echo $?; env test -n a -a -z ''; echo $?
1
0
0
$ env test 1 -gt 2 -o 3 -gt 2; echo $?
0
$ env test '(' a ')'; echo $?; env test '(' a -a b ')' -o c; echo $?; env test '(' '' ')' -o '(' x ')'; echo $?
0
0
0
$ env test a -eq 1; echo $?
test: invalid integer ‘a’
2
$ env test 1x -eq 1; echo $?
test: invalid integer ‘1x’
2
$ env test 1 -eq ''; echo $?
test: invalid integer ‘’
2
$ env test 1 -lt; echo $?
test: missing argument after ‘-lt’
2
$ env test -q a; echo $?
test: ‘-q’: unary operator expected
2
$ env test a b; echo $?
test: missing argument after ‘b’
2
$ env test a b c; echo $?
test: ‘b’: binary operator expected
2
$ env test a b c d e; echo $?
test: extra argument ‘b’
2
$ env test '(' a; echo $?
test: missing argument after ‘a’
2
$ env test '(' ')'; echo $?
test: missing argument after ‘)’
2
$ env test a -a; echo $?
test: missing argument after ‘-a’
2
$ env test 1 -eq 1 -a; echo $?
test: missing argument after ‘-a’
2
$ env test a '<' b; echo $?
test: ‘<’: binary operator expected
2
$ env test -v X; echo $?
test: ‘-v’: unary operator expected
2
$ env test -o x; echo $?
test: ‘-o’: unary operator expected
2
$ env test -a -a -a; echo $?
test: ‘-a’: unary operator expected
2
$ env test '(' a b c d e ')'; echo $?
test: ‘)’ expected, found ‘b’
2
$ env test '(' a -a b; echo $?
test: ‘)’ expected
2
$ env test -l ab -nt x; echo $?
test: -nt does not accept -l
2
$ env [ a ]; echo $?; env [ ]; echo $?; env [ -d / ]; echo $?
0
1
0
$ env [ a; echo $?
[: missing ‘]’
2
$ env [; echo $?
[: missing ‘]’
2
$ /usr/bin/[ a; echo $?
/usr/bin/[: missing ‘]’
2
$ /usr/bin/test a = b; echo $?
1
$ env [ --help | head -3
Usage: test EXPRESSION
  or:  test
  or:  [ EXPRESSION ]
$ env test --help; echo $?
0
