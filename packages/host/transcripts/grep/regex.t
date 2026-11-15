# grep: basic and extended regular expressions, fixed strings, -w and -x, patterns from files.
# tags: golden-verified
% printf 'foo\nbar\nFoo bar\nbaz\na+b\na|b\n(x)\n{1}\n$5 total\n^up\nend.\nback\\slash\naaa\nabcabc\n' > t
% printf 'café\nÉCOLE\nnaïve\nσ ς Σ\n٣ digits 3\n_under\ntab\there\nnbsp here\n' > u
$ grep 'ba.' t
bar
Foo bar
baz
back\slash
$ grep '^ba' t
bar
baz
back\slash
$ grep 'r$' t
bar
Foo bar
$ grep 'a\+b' t
abcabc
$ grep 'a+b' t
a+b
$ grep -E 'a+b' t
abcabc
$ grep -E 'a\+b' t
a+b
$ grep 'a|b' t
a|b
$ grep 'a\|z' t
bar
Foo bar
baz
a+b
a|b
$5 total
back\slash
aaa
abcabc
$ grep -E 'a|z' t
bar
Foo bar
baz
a+b
a|b
$5 total
back\slash
aaa
abcabc
$ grep -E '^(foo|baz)$' t
foo
baz
$ grep '\(x\)' t
(x)
$ grep '(x)' t
(x)
$ grep -E '\(x\)' t
(x)
$ grep -E '{1}' t
grep: warning: {...} at start of expression
foo
bar
Foo bar
baz
a+b
a|b
(x)
{1}
$5 total
^up
end.
back\slash
aaa
abcabc
$ grep '{1}' t
{1}
$ grep 'a\{3\}' t
aaa
$ grep -E 'a{2,}' t
aaa
$ grep -E '(abc){2}' t
abcabc
$ grep '\(abc\)\1' t
abcabc
$ grep -E '(a)\1\1' t
aaa
$ grep '$5' t
$5 total
$ grep -E '\$5' t
$5 total
$ grep 'x$5' t
[exit 1]
$ grep '^^' t
^up
$ grep 'p^' t
[exit 1]
$ grep -E '^\^' t
^up
$ grep 'end\.' t
end.
$ grep 'k\\s' t
back\slash
$ grep '*' t
[exit 1]
$ grep -E 'a**' t | head -2
foo
bar
$ grep '[[:upper:]]' t
Foo bar
$ grep '[[:digit:]]' t
{1}
$5 total
$ grep '[[:punct:]]' t | head -3
a+b
a|b
(x)
$ grep '[^[:alnum:] ]' t
a+b
a|b
(x)
{1}
$5 total
^up
end.
back\slash
$ grep '[]x]' t
(x)
$ grep '[a-c]\{3\}' t
back\slash
aaa
abcabc
$ grep 'b[[:space:]]' t
[exit 1]
$ grep '\<ba' t
bar
Foo bar
baz
back\slash
$ grep 'ar\>' t
bar
Foo bar
$ grep '\bbar\b' t
bar
Foo bar
$ grep 'o\B' t
foo
Foo bar
$5 total
$ grep '\w\W\w' t
Foo bar
a+b
a|b
$5 total
back\slash
$ grep '\S\s\S' t
Foo bar
$5 total
$ grep -c '' t
14
$ grep -E '' t | wc -l
14
# Unicode: classes of the C.UTF-8 locale.
$ grep '[[:alpha:]]é' u
café
$ grep -i 'école' u
ÉCOLE
$ grep -i 'Σ' u
σ ς Σ
$ grep '[[:upper:]]' u
ÉCOLE
σ ς Σ
$ grep '^[[:alpha:]]' u
café
ÉCOLE
naïve
σ ς Σ
٣ digits 3
tab	here
nbsp here
$ grep '[[:digit:]]' u
٣ digits 3
$ grep '\w\w*' u | head -3
café
ÉCOLE
naïve
$ grep -o '[[:space:]]' u | wc -l
6
$ grep -c '[[:blank:]]' u
4
$ grep 'na.ve' u
naïve
$ grep -o 'caf.' u
café
# Fixed strings, -w, -x, several patterns.
$ grep -F 'a+b' t
a+b
$ grep -F '$5' t
$5 total
$ grep -F '.' t
end.
$ grep -F 'back\slash' t
back\slash
$ grep -Fx 'bar' t
bar
$ grep -Fi 'FOO' t
foo
Foo bar
$ grep -w 'ba' t
[exit 1]
$ grep -w 'bar\|ab' t
bar
Foo bar
$ grep -wo 'a\|aaa' t
a
a
aaa
$ grep -x 'ba.' t
bar
baz
$ grep -xE 'foo|baz' t
foo
baz
$ grep -e foo -e '^ba' t
foo
bar
baz
back\slash
$ grep 'foo
> baz' t
foo
baz
$ printf 'foo\n^ba\n' > pats; grep -f pats t
foo
bar
baz
back\slash
$ grep -f pats -e end t
foo
bar
baz
end.
back\slash
$ printf '' > none; grep -f none t; echo $?
1
$ grep -v -c -f none t
14
$ grep -f nope t
grep: nope: No such file or directory
[exit 2]
$ printf 'foo\n' | grep -f - t
foo
