# ls --color: the built-in colors when LS_COLORS is unset (directories, links, executables,
# set-id files, sticky and other-writable directories), LS_COLORS, the terminal type check,
# --color=auto in a pipe, and no tabs in colored columns. Escapes are shown with cat -v.
# tags: golden-verified
% mkdir c && cd c && touch f exe suid sgid a.tar B.TXT c.Txt && mkdir dir sticky ow tw && chmod 755 exe && chmod 4755 suid && chmod 2755 sgid && chmod 1755 sticky && chmod 777 ow && chmod 1777 tw && ln -s f fl && ln -s dir dl && ln -s nowhere broken
% touch -d '2026-11-10 08:30:00' f exe suid sgid a.tar B.TXT c.Txt dir sticky ow tw
$ ls --color=always | cat -v
B.TXT
a.tar
^[[0m^[[01;36mbroken^[[0m
c.Txt
^[[01;34mdir^[[0m
^[[01;36mdl^[[0m
^[[01;32mexe^[[0m
f
^[[01;36mfl^[[0m
^[[34;42mow^[[0m
^[[30;43msgid^[[0m
^[[37;44msticky^[[0m
^[[37;41msuid^[[0m
^[[30;42mtw^[[0m
$ ls --color | cat -v
B.TXT
a.tar
^[[0m^[[01;36mbroken^[[0m
c.Txt
^[[01;34mdir^[[0m
^[[01;36mdl^[[0m
^[[01;32mexe^[[0m
f
^[[01;36mfl^[[0m
^[[34;42mow^[[0m
^[[30;43msgid^[[0m
^[[37;44msticky^[[0m
^[[37;41msuid^[[0m
^[[30;42mtw^[[0m
$ ls --color=yes -F | cat -v
B.TXT
a.tar
^[[0m^[[01;36mbroken^[[0m@
c.Txt
^[[01;34mdir^[[0m/
^[[01;36mdl^[[0m@
^[[01;32mexe^[[0m*
f
^[[01;36mfl^[[0m@
^[[34;42mow^[[0m/
^[[30;43msgid^[[0m*
^[[37;44msticky^[[0m/
^[[37;41msuid^[[0m*
^[[30;42mtw^[[0m/
$ ls --color=force -C | cat -A
B.TXT  a.tar  ^[[0m^[[01;36mbroken^[[0m  c.Txt  ^[[01;34mdir^[[0m  ^[[01;36mdl^[[0m  ^[[01;32mexe^[[0m  f  ^[[01;36mfl^[[0m  ^[[34;42mow^[[0m  ^[[30;43msgid^[[0m  ^[[37;44msticky^[[0m  ^[[37;41msuid^[[0m  ^[[30;42mtw^[[0m$
$ ls -C | cat -A
B.TXT  a.tar  broken  c.Txt  dir  dl  exe  f  fl  ow  sgid  sticky  suid  tw$
$ ls --color=auto | cat -v
B.TXT
a.tar
broken
c.Txt
dir
dl
exe
f
fl
ow
sgid
sticky
suid
tw
$ ls --color=tty -1 | cat -v
B.TXT
a.tar
broken
c.Txt
dir
dl
exe
f
fl
ow
sgid
sticky
suid
tw
$ ls --color=never -1 | cat -v
B.TXT
a.tar
broken
c.Txt
dir
dl
exe
f
fl
ow
sgid
sticky
suid
tw
$ ls --color=always --color=never -1 | cat -v
B.TXT
a.tar
broken
c.Txt
dir
dl
exe
f
fl
ow
sgid
sticky
suid
tw
$ ls --color=always -l --time-style=+ | cat -v
total 16
-rw-r--r-- 1 student student    0  B.TXT
-rw-r--r-- 1 student student    0  a.tar
lrwxrwxrwx 1 student student    7  ^[[0m^[[01;36mbroken^[[0m -> nowhere
-rw-r--r-- 1 student student    0  c.Txt
drwxr-xr-x 2 student student 4096  ^[[01;34mdir^[[0m
lrwxrwxrwx 1 student student    3  ^[[01;36mdl^[[0m -> dir
-rwxr-xr-x 1 student student    0  ^[[01;32mexe^[[0m
-rw-r--r-- 1 student student    0  f
lrwxrwxrwx 1 student student    1  ^[[01;36mfl^[[0m -> f
drwxrwxrwx 2 student student 4096  ^[[34;42mow^[[0m
-rwxr-sr-x 1 student student    0  ^[[30;43msgid^[[0m
drwxr-xr-t 2 student student 4096  ^[[37;44msticky^[[0m
-rwsr-xr-x 1 student student    0  ^[[37;41msuid^[[0m
drwxrwxrwt 2 student student 4096  ^[[30;42mtw^[[0m
$ ls --color=always -lF --time-style=+ fl dl broken | cat -v
lrwxrwxrwx 1 student student 7  ^[[0m^[[01;36mbroken^[[0m -> nowhere
lrwxrwxrwx 1 student student 3  ^[[01;36mdl^[[0m -> ^[[01;34mdir^[[0m/
lrwxrwxrwx 1 student student 1  ^[[01;36mfl^[[0m -> f
$ ls --color=always -L -1 | cat -v
ls: cannot access 'broken': No such file or directory
B.TXT
a.tar
^[[0m^[[01;36mbroken^[[0m
c.Txt
^[[01;34mdir^[[0m
^[[01;34mdl^[[0m
^[[01;32mexe^[[0m
f
fl
^[[34;42mow^[[0m
^[[30;43msgid^[[0m
^[[37;44msticky^[[0m
^[[37;41msuid^[[0m
^[[30;42mtw^[[0m
$ ls --color=always -1 nope f | cat -v
ls: cannot access 'nope': No such file or directory
f
$ ls --color=always -d dir dl | cat -v
^[[0m^[[01;34mdir^[[0m
^[[01;36mdl^[[0m
$ ls --color=always -w 10 -1 dir averyveryverylongname | cat -v
ls: cannot access 'averyveryverylongname': No such file or directory
dir:
$ ls --color=always /dev/null | cat -v
^[[0m^[[01;33m/dev/null^[[0m
#
# LS_COLORS, and the terminal check when it is unset.
$ LS_COLORS='di=01;35:ex=31' ls --color=always -1 dir exe f | cat -v
^[[0m^[[31mexe^[[0m
f

dir:
$ LS_COLORS='*.tar=01;31' ls --color=always -1 a.tar f | cat -v
^[[0m^[[01;31ma.tar^[[0m
f
$ LS_COLORS='*.TXT=31:*.txt=32' ls --color=always -1 B.TXT c.Txt | cat -v
^[[0m^[[31mB.TXT^[[0m
c.Txt
$ LS_COLORS='*.TXT=31' ls --color=always -1 B.TXT c.Txt | cat -v
^[[0m^[[31mB.TXT^[[0m
^[[31mc.Txt^[[0m
$ LS_COLORS='or=31' ls --color=always -l --time-style=+ fl dl broken | cat -v
lrwxrwxrwx 1 student student 7  ^[[0m^[[31mbroken^[[0m -> ^[[31mnowhere^[[0m
lrwxrwxrwx 1 student student 3  ^[[01;36mdl^[[0m -> ^[[01;34mdir^[[0m
lrwxrwxrwx 1 student student 1  ^[[01;36mfl^[[0m -> f
$ LS_COLORS='mi=31' ls --color=always -l --time-style=+ fl dl broken | cat -v
lrwxrwxrwx 1 student student 7  ^[[0m^[[01;36mbroken^[[0m -> ^[[31mnowhere^[[0m
lrwxrwxrwx 1 student student 3  ^[[01;36mdl^[[0m -> ^[[01;34mdir^[[0m
lrwxrwxrwx 1 student student 1  ^[[01;36mfl^[[0m -> f
$ LS_COLORS='ln=target' ls --color=always -1 fl broken | cat -v
broken
fl
$ LS_COLORS='no=35:fi=36' ls --color=always -l f exe | cat -v
^[[0m^[[35m-rwxr-xr-x 1 student student 0 Nov 10 08:30 ^[[m^[[01;32mexe^[[0m
^[[35m-rw-r--r-- 1 student student 0 Nov 10 08:30 ^[[m^[[36mf^[[0m
$ LS_COLORS='ec=\e[0m:lc=\e[:rc=m' ls --color=always -1 dir f | cat -v
f

dir:
$ LS_COLORS='di=4^[x' ls --color=always -d dir | cat -v
^[[0m^[[4^[xmdir^[[0m
$ LS_COLORS='zz=1' ls --color=always -d dir | cat -v
ls: unrecognized prefix: ‘zz’
ls: unparsable value for LS_COLORS environment variable
dir
$ LS_COLORS='di' ls --color=always -d dir | cat -v
ls: unparsable value for LS_COLORS environment variable
dir
$ LS_COLORS= ls --color=always -d dir | cat -v
^[[0m^[[01;34mdir^[[0m
$ TERM=dumb ls --color=always -d dir | cat -v
dir
$ TERM=dumb COLORTERM=truecolor ls --color=always -d dir | cat -v
^[[0m^[[01;34mdir^[[0m
$ TERM=screen-256color ls --color=always -d dir | cat -v
^[[0m^[[01;34mdir^[[0m
$ TERM=vt220 ls --color=always -d dir | cat -v
dir
