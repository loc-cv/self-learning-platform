# The coreutils printf binary (env printf, /usr/bin/printf): conversions, escapes, %b, %q, numeric
# arguments and their errors, format reuse, invalid directives.
# tags: golden-verified
$ env printf '%s\n' a b
a
b
$ env printf abc; echo
abc
$ env printf '%5.2f|%-4s|%x|%o|%e|%g|%c|%i\n' 3.14159 ab 255 8 1234.5 0.0001 xyz 7
 3.14|ab  |ff|10|1.234500e+03|0.0001|x|7
$ env printf '%d\n' 0x1f 010 -5 +3 " 7"
31
8
-5
3
7
$ env printf '%u %x\n' -1 -1
18446744073709551615 ffffffffffffffff
$ env printf '%#x %#o %+d % d|%05d|%-5d|%.3d\n' 255 8 5 5 42 42 5
0xff 010 +5  5|00042|42   |005
$ env printf '%ld %hd %lld %jd %Lf\n' 1 2 3 4 1
1 2 3 4 1.000000
$ env printf '%*d|%-*d|%.*f\n' 5 1 4 2 2 3.14159
    1|2   |3.14
$ env printf '%.*d|\n' -3 5
5|
$ env printf '%10.3s|%-4c|\n' abcdef x
       abc|x   |
$ env printf '%.2s|%5s|\n' éa é
é|   é|
$ env printf '%c|\n' '' | cat -v
^@|
$ env printf '%d %d\n' "'A" '"a'
65 97
$ env printf '%d\n' "'ab"
printf: warning: b: character(s) following character constant have been ignored
97
$ env printf '%f %g %G %E\n' 0x1p3 1e-10 1e-10 5
8.000000 1e-10 1E-10 5.000000E+00
$ env printf '%f %f %f\n' inf nan -0
inf nan -0.000000
$ env printf '%.20g|%.25f\n' 0.1 0.1
0.1|0.1000000000000000000013553
$ env printf '%#.1g|%#5.0f|\n' 3 2
3.|   2.|
$ env printf '%s %s\n' a b c
a b
c 
$ env printf '%s\n'

$ env printf '%d|\n'
0|
$ env printf '%%|%b|%q\n' 'a\tb\0101\101\1010' 'a b'
%|a	bAAA0|'a b'
$ env printf '%q\n' "it's" '' 'a$b' '~x' 'x~' '#a' $'a\nb'
"it's"
''
'a$b'
'~x'
x~
'#a'
'a'$'\n''b'
$ env printf '\x41\101\0101|\e|\"|\q|é|\U0001F600\n' | cat -v
AA^H1|^[|"|\q|M-CM-)|M-pM-^_M-^XM-^@
$ env printf 'a\c b'; echo " $?"
a 0
$ env printf '%b|%b\n' 'x\cy' z; echo " $?"
x 0
$ env printf 'x%d\ny%d\n' a b; echo $?
xprintf: ‘a’: expected a numeric value
0
yprintf: ‘b’: expected a numeric value
0
1
$ env printf '%d\n' 12abc; echo $?
printf: ‘12abc’: value not completely converted
12
1
$ env printf '%d\n' 08 0x ''; echo $?
printf: ‘08’: value not completely converted
0
printf: ‘0x’: value not completely converted
0
0
1
$ env printf '%d\n' 99999999999999999999 -9223372036854775809; echo $?
printf: ‘99999999999999999999’: Numerical result out of range
9223372036854775807
printf: ‘-9223372036854775809’: Numerical result out of range
-9223372036854775808
1
$ env printf '%u\n' 18446744073709551616; echo $?
printf: ‘18446744073709551616’: Numerical result out of range
18446744073709551615
1
$ env printf '%f\n' 1,5; echo $?
printf: ‘1,5’: value not completely converted
1.000000
1
$ env printf '%i\n' 1.5; echo $?
printf: ‘1.5’: value not completely converted
1
1
$ env printf '%d\n' "'"; echo $?
printf: ‘'’: expected a numeric value
0
1
$ env printf '%f\n' "'a"
97.000000
$ env printf abc x y; echo $?
abcprintf: warning: ignoring excess arguments, starting with ‘x’
0
$ env printf 'a%zb\n'; echo $?
aprintf: %zb: invalid conversion specification
1
$ env printf '%5%|\n'; echo $?
printf: %5%: invalid conversion specification
1
$ env printf '%-5b|\n' x; echo $?
printf: %-5b: invalid conversion specification
1
$ env printf '%10q|\n' x; echo $?
printf: %10q: invalid conversion specification
1
$ env printf '%#s|\n' a; echo $?
printf: %#s: invalid conversion specification
1
$ env printf '%05s|\n' a; echo $?
printf: %05s: invalid conversion specification
1
$ env printf '%.2c|\n' a; echo $?
printf: %.2c: invalid conversion specification
1
$ env printf '%#d|\n' 1; echo $?
printf: %#d: invalid conversion specification
1
$ env printf "%'d|%Id|%-c|% s|%+s|\n" 1000 1 a a a
1000|1|a|a|a|
$ env printf 'ab%'; echo $?
abprintf: %: invalid conversion specification
1
$ env printf '%*d|\n' 99999999999 1; echo $?
printf: invalid field width: ‘99999999999’
1
$ env printf '\x|\n'; echo $?
printf: missing hexadecimal number in escape
1
$ env printf '\u12\n'; echo $?
printf: missing hexadecimal number in escape
1
$ env printf '\uD800\n'; echo $?
printf: invalid universal character name \ud800
1
$ env printf 'a\'; echo " $?"
a\ 0
$ env printf; echo $?
printf: missing operand
Try 'printf --help' for more information.
1
$ env printf -- '%s\n' x
x
$ env printf -x; echo
-x
$ env printf --help x; echo
--helpprintf: warning: ignoring excess arguments, starting with ‘x’

$ /usr/bin/printf --help | head -2
Usage: /usr/bin/printf FORMAT [ARGUMENT]...
  or:  /usr/bin/printf OPTION
