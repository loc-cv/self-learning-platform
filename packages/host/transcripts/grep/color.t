# grep: --color, GREP_COLORS and GREP_COLOR; the escape sequences are shown with cat -v.
# tags: golden-verified
% printf 'foo\nbar\nFoo bar\nbaz\n' > a; printf 'x\n' > b; seq 1 20 > n
$ grep --color=always -n -H o a | cat -v
^[[35m^[[Ka^[[m^[[K^[[36m^[[K:^[[m^[[K^[[32m^[[K1^[[m^[[K^[[36m^[[K:^[[m^[[Kf^[[01;31m^[[Ko^[[m^[[K^[[01;31m^[[Ko^[[m^[[K
^[[35m^[[Ka^[[m^[[K^[[36m^[[K:^[[m^[[K^[[32m^[[K3^[[m^[[K^[[36m^[[K:^[[m^[[KF^[[01;31m^[[Ko^[[m^[[K^[[01;31m^[[Ko^[[m^[[K bar
$ grep --color=always -c o a b | cat -v
^[[35m^[[Ka^[[m^[[K^[[36m^[[K:^[[m^[[K2
^[[35m^[[Kb^[[m^[[K^[[36m^[[K:^[[m^[[K0
$ grep --color=always -l o a b | cat -v
^[[35m^[[Ka^[[m^[[K
$ grep --color=always -A1 -n foo a b | cat -v
^[[35m^[[Ka^[[m^[[K^[[36m^[[K:^[[m^[[K^[[32m^[[K1^[[m^[[K^[[36m^[[K:^[[m^[[K^[[01;31m^[[Kfoo^[[m^[[K
^[[35m^[[Ka^[[m^[[K^[[36m^[[K-^[[m^[[K^[[32m^[[K2^[[m^[[K^[[36m^[[K-^[[m^[[Kbar
$ grep --color=always -v foo a | cat -v
bar
Foo bar
baz
$ grep --color=always -v -C1 bar a | cat -v
foo
^[[01;31m^[[Kbar^[[m^[[K
Foo ^[[01;31m^[[Kbar^[[m^[[K
baz
$ grep --color=always -o -b o a | cat -v
^[[32m^[[K1^[[m^[[K^[[36m^[[K:^[[m^[[K^[[01;31m^[[Ko^[[m^[[K
^[[32m^[[K2^[[m^[[K^[[36m^[[K:^[[m^[[K^[[01;31m^[[Ko^[[m^[[K
^[[32m^[[K9^[[m^[[K^[[36m^[[K:^[[m^[[K^[[01;31m^[[Ko^[[m^[[K
^[[32m^[[K10^[[m^[[K^[[36m^[[K:^[[m^[[K^[[01;31m^[[Ko^[[m^[[K
$ grep --color=always '' a | cat -v
foo
bar
Foo bar
baz
$ grep --color=always 'x*' b | cat -v
^[[01;31m^[[Kx^[[m^[[K
$ grep --color=always -C1 -e 5 -e 9 n | head -5 | cat -v
4
^[[01;31m^[[K5^[[m^[[K
6
^[[36m^[[K--^[[m^[[K
8
$ grep --color=always -i 'o\|ba' a | cat -v
f^[[01;31m^[[Ko^[[m^[[K^[[01;31m^[[Ko^[[m^[[K
^[[01;31m^[[Kba^[[m^[[Kr
F^[[01;31m^[[Ko^[[m^[[K^[[01;31m^[[Ko^[[m^[[K ^[[01;31m^[[Kba^[[m^[[Kr
^[[01;31m^[[Kba^[[m^[[Kz
$ grep --color=always -Z -l foo a | cat -v
^[[35m^[[Ka^[[m^[[K^@ (no-eol)
$ grep --colour foo a | cat -v
foo
$ grep --color foo a | cat -v
foo
$ grep --color=auto foo a | cat -v
foo
$ grep --color=yes foo a | cat -v
^[[01;31m^[[Kfoo^[[m^[[K
$ grep --color=force foo a | cat -v
^[[01;31m^[[Kfoo^[[m^[[K
$ grep --color=ALWAYS foo a | cat -v
^[[01;31m^[[Kfoo^[[m^[[K
$ grep --color=none foo a | cat -v
foo
$ grep --color=tty foo a | cat -v
foo
$ grep --color=always --color=never foo a | cat -v
foo
$ GREP_COLOR='01;32' grep --color=always foo a | cat -v
grep: warning: GREP_COLOR='01;32' is deprecated; use GREP_COLORS='mt=01;32'
^[[01;32m^[[Kfoo^[[m^[[K
$ GREP_COLORS='mt=01;34:fn=33:ln=1:se=0:sl=7' grep --color=always -n foo a b | cat -v
^[[33m^[[Ka^[[m^[[K^[[0m^[[K:^[[m^[[K^[[1m^[[K1^[[m^[[K^[[0m^[[K:^[[m^[[K^[[7m^[[K^[[01;34m^[[Kfoo^[[m^[[K
$ GREP_COLORS='ne' grep --color=always -n foo a | cat -v
^[[32m1^[[m^[[36m:^[[m^[[01;31mfoo^[[m
$ GREP_COLORS='zz=1:ms=' grep --color=always foo a | cat -v
foo
$ GREP_COLORS='ms=01;32:x' grep --color=always foo a | cat -v
^[[01;32m^[[Kfoo^[[m^[[K
$ GREP_COLORS='ms=1=2:fn=33' grep --color=always -H foo a | cat -v
^[[35m^[[Ka^[[m^[[K^[[36m^[[K:^[[m^[[K^[[01;31m^[[Kfoo^[[m^[[K
$ GREP_COLOR='01;32' GREP_COLORS='mt=01;34' grep --color=always foo a | cat -v
^[[01;34m^[[Kfoo^[[m^[[K
$ GREP_COLORS='sl=1:cx=2:rv' grep --color=always -v -A1 foo a | cat -v
^[[2m^[[Kbar^[[m^[[K
^[[2m^[[KFoo bar^[[m^[[K
^[[2m^[[Kbaz^[[m^[[K
$ GREP_COLORS='cx=2' grep --color=always -A1 foo a | cat -v
^[[01;31m^[[Kfoo^[[m^[[K
^[[2m^[[Kbar^[[m^[[K
# On the terminal: no color without --color (no alias is defined); auto colors.
$ grep foo a
foo
$ grep --color=auto foo a
[01;31m[Kfoo[m[K
$ TERM=dumb grep --color=auto foo a
foo
