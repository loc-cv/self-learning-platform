# Quoting and expansion: single and double quotes, backslashes, parameters, defaults, splitting,
# tilde, braces, globs, command substitution.
# tags: golden-verified
$ echo 'single $HOME "x"' "double $HOME 'x'" back\ slash \$HOME
single $HOME "x" double /home/student 'x' back slash $HOME
$ x='a   b'; echo $x; echo "$x"; echo '$x'
a b
a   b
$x
$ echo "${x}c" ${nope:-default} "${nope:-two words}" ${x:+set} ${nope:+set}
a   bc default two words set
$ y=; echo "[${y:-empty}]" "[${y-unset}]"
[empty] []
$ echo ${z:=assigned}; echo $z
assigned
assigned
$ echo $'tab\there' "a\"b" 'it'\''s'
tab	here a"b it's
$ echo $'\u00e9 \u65e5\U0001F600 \x41\101 \u'
é 日😀 AA \u
$ echo ~ ~/x ~root "~" x~
/home/student /home/student/x /root ~ x~
$ X=~/a:~/b; echo $X; export X=~; echo $X; export X=~/a:~/b; echo $X
/home/student/a:/home/student/b
/home/student
/home/student/a:/home/student/b
$ echo X=~/a Y=a:~/b foo=~ x~/b a=b~
X=/home/student/a Y=a:/home/student/b foo=/home/student x~/b a=b~
$ export X="~/a"; echo $X; export Q=a~/b; echo $Q; export "P"=~/a; echo $P
~/a
a~/b
~/a
$ export ~/a; echo $?
-bash: export: `/home/student/a': not a valid identifier
1
$ echo a{b,c,d}e {1..4} {a..c} {01..03} {3..1} x{}y {a}
abe ace ade 1 2 3 4 a b c 01 02 03 3 2 1 x{}y {a}
$ echo $(echo inner $(echo nested)) "$(printf 'two\nlines')"
inner nested two
lines
$ echo `echo backtick`
backtick
$ v=$(echo   spaced    out  ); echo "$v"
spaced out
% mkdir g; touch g/a.txt g/b.txt g/c.log g/.hidden
$ echo g/*.txt g/? g/[ab]* g/*.none
g/a.txt g/b.txt g/? g/a.txt g/b.txt g/*.none
$ echo g/* "g/*" g/\*
g/a.txt g/b.txt g/c.log g/* g/*
$ echo $#; set_x=1; echo ${#set_x}
0
1
$ false; echo "$?" $?
1 1
$ echo a#b # a comment
a#b
$ echo "multi
> line" 'and
> this'
multi
line and
this
