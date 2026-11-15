# ls and symbolic links: `-> target`, indicators of the target, -L, -H, links to directories on
# the command line, dangling links. Symbolic links get the creation time (touch -h is not
# simulated), so long listings that show links use an empty time style.
# tags: golden-verified
% mkdir ln && cd ln && touch -d '2026-11-10 08:30:00' file exe && chmod +x exe && mkdir sub && touch -d '2026-11-10 08:30:00' sub/inner sub && ln -s file fl && ln -s exe el && ln -s sub dl && ln -s nowhere broken && ln -s 'a b' ql
$ ls
broken	dl  el	exe  file  fl  ql  sub
$ ls -l --time-style=+
total 4
lrwxrwxrwx 1 student student    7  broken -> nowhere
lrwxrwxrwx 1 student student    3  dl -> sub
lrwxrwxrwx 1 student student    3  el -> exe
-rwxr-xr-x 1 student student    0  exe
-rw-r--r-- 1 student student    0  file
lrwxrwxrwx 1 student student    4  fl -> file
lrwxrwxrwx 1 student student    3  ql -> 'a b'
drwxr-xr-x 2 student student 4096  sub
$ ls -lF --time-style=+
total 4
lrwxrwxrwx 1 student student    7  broken -> nowhere
lrwxrwxrwx 1 student student    3  dl -> sub/
lrwxrwxrwx 1 student student    3  el -> exe*
-rwxr-xr-x 1 student student    0  exe*
-rw-r--r-- 1 student student    0  file
lrwxrwxrwx 1 student student    4  fl -> file
lrwxrwxrwx 1 student student    3  ql -> 'a b'
drwxr-xr-x 2 student student 4096  sub/
$ ls -l --file-type --time-style=+
total 4
lrwxrwxrwx 1 student student    7  broken -> nowhere
lrwxrwxrwx 1 student student    3  dl -> sub/
lrwxrwxrwx 1 student student    3  el -> exe
-rwxr-xr-x 1 student student    0  exe
-rw-r--r-- 1 student student    0  file
lrwxrwxrwx 1 student student    4  fl -> file
lrwxrwxrwx 1 student student    3  ql -> 'a b'
drwxr-xr-x 2 student student 4096  sub/
$ ls -lp --time-style=+
total 4
lrwxrwxrwx 1 student student    7  broken -> nowhere
lrwxrwxrwx 1 student student    3  dl -> sub
lrwxrwxrwx 1 student student    3  el -> exe
-rwxr-xr-x 1 student student    0  exe
-rw-r--r-- 1 student student    0  file
lrwxrwxrwx 1 student student    4  fl -> file
lrwxrwxrwx 1 student student    3  ql -> 'a b'
drwxr-xr-x 2 student student 4096  sub/
$ ls -F
broken@  dl@  el@  exe*  file  fl@  ql@  sub/
$ ls --file-type
broken@  dl@  el@  exe	file  fl@  ql@	sub/
$ ls -p
broken	dl  el	exe  file  fl  ql  sub/
$ ls -F fl dl broken
broken@  dl@  fl@
$ ls -lnL
ls: cannot access 'broken': No such file or directory
ls: cannot access 'ql': No such file or directory
total 8
l????????? ? ?    ?       ?            ? broken
drwxr-xr-x 2 1000 1000 4096 Nov 10 08:30 dl
-rwxr-xr-x 1 1000 1000    0 Nov 10 08:30 el
-rwxr-xr-x 1 1000 1000    0 Nov 10 08:30 exe
-rw-r--r-- 1 1000 1000    0 Nov 10 08:30 file
-rw-r--r-- 1 1000 1000    0 Nov 10 08:30 fl
l????????? ? ?    ?       ?            ? ql
drwxr-xr-x 2 1000 1000 4096 Nov 10 08:30 sub
[exit 1]
$ ls -L
broken	dl  el	exe  file  fl  ql  sub
$ ls -FL
ls: cannot access 'broken': No such file or directory
ls: cannot access 'ql': No such file or directory
broken@  dl/  el*  exe*  file  fl  ql@	sub/
[exit 1]
$ ls -L broken
ls: cannot access 'broken': No such file or directory
[exit 2]
$ ls -lL broken
ls: cannot access 'broken': No such file or directory
[exit 2]
$ ls broken
broken
$ ls -l broken/
ls: cannot access 'broken/': No such file or directory
[exit 2]
$ ls dl
inner
$ ls -l dl --time-style=+
lrwxrwxrwx 1 student student 3  dl -> sub
$ ls -l dl/
total 0
-rw-r--r-- 1 student student 0 Nov 10 08:30 inner
$ ls -lH dl
total 0
-rw-r--r-- 1 student student 0 Nov 10 08:30 inner
$ ls -l --dereference-command-line-symlink-to-dir dl fl --time-style=+
lrwxrwxrwx 1 student student    4  fl -> file

dl:
total 0
-rw-r--r-- 1 student student 0  inner
$ ls -d dl
dl
$ ls -d dl/
dl/
$ ls -dL dl
dl
$ ls -R
.:
broken	dl  el	exe  file  fl  ql  sub

./sub:
inner
$ ls -RL
.:
ls: cannot access 'broken': No such file or directory
ls: cannot access 'ql': No such file or directory
broken	dl  el	exe  file  fl  ql  sub

./dl:
inner

./sub:
inner
[exit 1]
$ ls --group-directories-first
dl  sub  broken  el  exe  file	fl  ql
$ ls --group-directories-first -r
sub  dl  ql  fl  file  exe  el	broken
$ ls --group-directories-first -U -1 | wc -l
8
$ ls -l --group-directories-first --time-style=+
total 4
lrwxrwxrwx 1 student student    3  dl -> sub
drwxr-xr-x 2 student student 4096  sub
lrwxrwxrwx 1 student student    7  broken -> nowhere
lrwxrwxrwx 1 student student    3  el -> exe
-rwxr-xr-x 1 student student    0  exe
-rw-r--r-- 1 student student    0  file
lrwxrwxrwx 1 student student    4  fl -> file
lrwxrwxrwx 1 student student    3  ql -> 'a b'
$ ls -s
total 4
0 broken  0 dl	0 el  0 exe  0 file  0 fl  0 ql  4 sub
$ ls -ls --time-style=+
total 4
0 lrwxrwxrwx 1 student student    7  broken -> nowhere
0 lrwxrwxrwx 1 student student    3  dl -> sub
0 lrwxrwxrwx 1 student student    3  el -> exe
0 -rwxr-xr-x 1 student student    0  exe
0 -rw-r--r-- 1 student student    0  file
0 lrwxrwxrwx 1 student student    4  fl -> file
0 lrwxrwxrwx 1 student student    3  ql -> 'a b'
4 drwxr-xr-x 2 student student 4096  sub
#
# Allocated blocks: a link takes a block only when its target is 60 bytes or longer (ext4
# keeps shorter targets in the inode).
% mkdir ../long && cd ../long && ln -s $(printf '%059d' 0) l59 && ln -s $(printf '%060d' 0) l60 && ln -s $(printf '%0200d' 0) l200
$ ls -s
total 8
4 l200	0 l59  4 l60
$ ls -s1
total 8
4 l200
0 l59
4 l60
$ ls -sh
total 8.0K
4.0K l200     0 l59  4.0K l60
#
# -RL follows links into directories and stops at a loop.
% mkdir -p ../L/x && ln -s .. ../L/x/up && cd ..
$ ls -RL L
L:
x

L/x:
up
ls: L/x/up: not listing already-listed directory
[exit 2]
$ ls -R L
L:
x

L/x:
up
