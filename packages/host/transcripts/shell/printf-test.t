# The printf, test and [ builtins.
# tags: golden-verified
$ printf '%s-%d|%5s|%-4s|%03d|%x|%X|%o|%c|%%|%i|%u\n' a 42 hi yo 7 255 255 8 xyz -3 5
a-42|   hi|yo  |007|ff|FF|10|x|%|-3|5
$ printf '%s\n' one two three
one
two
three
$ printf '%s=%s\n' a 1 b
a=1
b=
$ printf 'no newline'
no newline (no-eol)
$ printf '%d\n' abc; echo $?
-bash: printf: abc: invalid number
0
1
$ printf '%d\n' 3.5 0x1f 010 "'A"; echo $?
-bash: printf: 3.5: invalid number
3
31
8
65
1
$ printf '%.2f|%8.3f|%-8.1f|%e|%g|%g|%G\n' 3.14159 2.5 1 1234.5 0.0001 1234567 0.00001234
3.14|   2.500|1.0     |1.234500e+03|0.0001|1.23457e+06|1.234E-05
$ printf '%5.2s|%.1s|%*d|%-*d|\n' abc xyz 4 7 3 8
   ab|x|   7|8  |
$ printf '%q %q %q\n' 'a b' "it's" plain
a\ b it\'s plain
$ printf '%b|%b\n' 'a\tb' '\0101'
a	b|A
$ printf '%b\n' 'stop\chere' after
stop (no-eol)
$ printf '\x41\101é\t|\n'
AAé	|
$ printf -v out '%s:%s' x y; echo "$out"
x:y
$ printf; echo $?
printf: usage: printf [-v var] format [arguments]
2
$ printf %z; echo $?
-bash: printf: `%z': missing format character
1
$ printf '%d %s\n'
0 
$ [ 1 -eq 1 ]; echo $?; [ a = b ]; echo $?; [ -z "" ]; echo $?; [ -n "" ]; echo $?
0
1
0
1
$ [ 1 -eq a ]; echo $?
-bash: [: a: integer expression expected
2
$ [ 1 = 1; echo $?
-bash: [: missing `]'
2
$ [ a b c ]; echo $?
-bash: [: b: binary operator expected
2
$ test; echo $?; test x; echo $?; [ ]; echo $?; test -x; echo $?
1
0
1
0
$ test 1 -foo 2; echo $?
-bash: test: -foo: binary operator expected
2
$ [ abc \< abd ]; echo $?; [ 2 -ge 10 ]; echo $?; [ -1 -lt 0 ]; echo $?; [ " 5 " -eq 5 ]; echo $?
0
1
0
0
$ test 99999999999999999999 -eq 1; echo $?
-bash: test: 99999999999999999999: integer expression expected
2
$ printf x > file; mkdir -p dir 2>/dev/null || bash -c 'exit 0'
$ [ -e file ] && [ -f file ] && [ -s file ] && [ -r file ] && [ -w file ] && echo yes; [ -d file ]; echo $?
yes
1
$ [ -d /tmp -a -f /etc/passwd ]; echo $?; [ ! -e /nope ]; echo $?; [ \( 1 -lt 2 \) -o 0 -gt 1 ]; echo $?
0
0
0
$ [ -x /usr/bin/cat ]; echo $?; [ -L /bin ]; echo $?; [ -h /bin/cat ]; echo $?; [ -k /tmp ]; echo $?
0
0
1
0
$ [ /etc/passwd -nt file ]; echo $?; [ file -nt nofile ]; echo $?; [ file -ef file ]; echo $?; [ -v HOME ]; echo $?; [ -v NOPE ]; echo $?
1
0
0
0
1
$ [ -t 0 ]; echo $?; [ -t 0 ] < /dev/null; echo $?
0
1
$ test ! x; echo $?; test ! ''; echo $?; test -z; echo $?
1
0
0
