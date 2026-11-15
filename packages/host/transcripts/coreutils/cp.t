# cp: files, into directories, -r, -p, -a, -f, -n, -u, -T, -t, links, errors.
# Modes are shown with `chmod -v u+` (which changes nothing), times compared with test -nt.
# tags: golden-verified
$ cp
cp: missing file operand
Try 'cp --help' for more information.
[exit 1]
$ cp a
cp: missing destination file operand after 'a'
Try 'cp --help' for more information.
[exit 1]
% printf 'hi\n' > a; mkdir d
$ cp -v a b; cp -v a b d; cat b d/a
'a' -> 'b'
'a' -> 'd/a'
'b' -> 'd/b'
hi
hi
$ cp a a
cp: 'a' and 'a' are the same file
[exit 1]
$ cp d e
cp: -r not specified; omitting directory 'd'
[exit 1]
$ cp -v nope x
cp: cannot stat 'nope': No such file or directory
[exit 1]
$ cp a b c
cp: target 'c': No such file or directory
[exit 1]
$ cp a b nod/
cp: target 'nod/': No such file or directory
[exit 1]
$ cp a nod/
cp: cannot create regular file 'nod/': Not a directory
[exit 1]
$ cp a nod/x
cp: cannot create regular file 'nod/x': No such file or directory
[exit 1]
$ cp -rv d e; cp -rv d e; echo $?
'd' -> 'e'
'd/a' -> 'e/a'
'd/b' -> 'e/b'
'd' -> 'e/d'
'd/a' -> 'e/d/a'
'd/b' -> 'e/d/b'
0
$ mkdir f; cp -v a f; cp -r d f/a
'a' -> 'f/a'
cp: cannot overwrite non-directory 'f/a' with directory 'd'
[exit 1]
$ mkdir -p g/a; cp a g
cp: cannot overwrite directory 'g/a' with non-directory
[exit 1]
$ cp -r d a
cp: cannot overwrite non-directory 'a' with directory 'd'
[exit 1]
$ cp -n -v b a; echo $?
cp: warning: behavior of -n is non-portable and may change in future; use --update=none instead
0
$ cp -n a newfile; cat newfile
cp: warning: behavior of -n is non-portable and may change in future; use --update=none instead
hi
% chmod 400 b
$ cp a b
cp: cannot create regular file 'b': Permission denied
[exit 1]
$ cp -f a b; echo $?
0
$ cp -fv a b
'a' -> 'b'
$ mkdir ro; chmod 555 ro; cp a ro/
cp: cannot create regular file 'ro/a': Permission denied
[exit 1]
% chmod 000 a
$ cp a z
cp: cannot open 'a' for reading: Permission denied
[exit 1]
% chmod 644 a
$ cp -T a d
cp: cannot overwrite directory 'd' with non-directory
[exit 1]
$ cp -t d a b -v
'a' -> 'd/a'
'b' -> 'd/b'
$ cp -t nod a
cp: target directory 'nod': No such file or directory
[exit 1]
$ cp -t a b
cp: target directory 'a': Not a directory
[exit 1]
$ cp -T a b c
cp: extra operand 'c'
Try 'cp --help' for more information.
[exit 1]
$ cp -t d -T a b
cp: cannot combine --target-directory (-t) and --no-target-directory (-T)
[exit 1]
$ cp -r d d/sub
cp: cannot copy a directory, 'd', into itself, 'd/sub'
[exit 1]
$ cp -r d d
cp: cannot copy a directory, 'd', into itself, 'd/d'
[exit 1]
$ cp -v a ./a
cp: 'a' and './a' are the same file
[exit 1]
$ ln a hl; cp a hl
cp: 'a' and 'hl' are the same file
[exit 1]
$ ln -s a sl; cp sl a
cp: 'sl' and 'a' are the same file
[exit 1]
$ cp -v sl s2; [ -L s2 ] || echo regular
'sl' -> 's2'
regular
$ cp -rv sl s3; [ -L s3 ] && echo link
'sl' -> 's3'
link
$ cp -Pv sl s4; cp -dv sl s5; [ -L s4 ] && [ -L s5 ] && echo links
'sl' -> 's4'
'sl' -> 's5'
links
$ cp -Lv sl s6; [ -L s6 ] || echo regular
'sl' -> 's6'
regular
$ cp -r a/ x
cp: cannot stat 'a/': Not a directory
[exit 1]
# Modes and times: a new copy takes the source's permission bits through the umask; -p keeps times.
% touch -d '2026-11-10 08:30:00' m; chmod 640 m
$ cp m m1; chmod -v u+ m1; [ m1 -nt m ] && echo newer
mode of 'm1' retained as 0640 (rw-r-----)
newer
$ cp -p m m2; chmod -v u+ m2; [ m2 -nt m ] || [ m -nt m2 ] || echo same
mode of 'm2' retained as 0640 (rw-r-----)
same
$ chmod 777 m; cp m m3; chmod -v u+ m3
mode of 'm3' retained as 0755 (rwxr-xr-x)
$ cp --preserve=mode m m4; chmod -v u+ m4
mode of 'm4' retained as 0777 (rwxrwxrwx)
$ cp --no-preserve=mode m m5; chmod -v u+ m5
mode of 'm5' retained as 0644 (rw-r--r--)
$ chmod 4755 m; cp m m6; chmod -v u+ m6; cp -p m m7; chmod -v u+ m7
mode of 'm6' retained as 0755 (rwxr-xr-x)
mode of 'm7' retained as 4755 (rwsr-xr-x)
$ printf 'x\n' > m1; chmod 600 m1; chmod 755 m; cp m m1; chmod -v u+ m1
mode of 'm1' retained as 0600 (rw-------)
# Directories: modes, -a keeps the directory's time and hard links between its files.
% mkdir sd; chmod 750 sd; touch sd/f; touch -d 2026-01-01 sd
$ cp -r sd cd; chmod -v u+ cd; [ cd -nt sd ] && echo newer
mode of 'cd' retained as 0750 (rwxr-x---)
newer
$ cp -a sd ad; chmod -v u+ ad; [ ad -nt sd ] || [ sd -nt ad ] || echo same
mode of 'ad' retained as 0750 (rwxr-x---)
same
% mkdir hd; touch hd/x; ln hd/x hd/y
$ cp -a hd ha; [ ha/x -ef ha/y ] && echo linked
linked
$ cp -r hd hr; [ hr/x -ef hr/y ] || echo separate
separate
% chmod 500 sd
$ cp -r sd rd; chmod -v u+ rd; touch rd/new; echo $?
mode of 'rd' retained as 0500 (r-x------)
touch: cannot touch 'rd/new': Permission denied
1
% chmod 700 sd
$ cp -p /etc/hostname h; [ h -nt /etc/hostname ] || [ /etc/hostname -nt h ] || echo same
same
$ cp --preserve=bogus a pb
cp: invalid argument ‘bogus’ for ‘--preserve’
Valid arguments are:
  - ‘mode’
  - ‘timestamps’
  - ‘ownership’
  - ‘links’
  - ‘context’
  - ‘xattr’
  - ‘all’
Try 'cp --help' for more information.
[exit 1]
$ cp --update=x a b
cp: invalid argument ‘x’ for ‘--update’
Valid arguments are:
  - ‘all’
  - ‘none’
  - ‘older’
Try 'cp --help' for more information.
[exit 1]
$ touch -d 2026-01-01 old; touch -d 2026-06-01 new; cp -uv old new; echo $?
0
$ cp -v --update=all old new
'old' -> 'new'
$ cp -v --update=none a new; echo $?
0
$ cp -l a lnk; [ a -ef lnk ] && echo linked
linked
$ cp -lv a lnk2
'a' -> 'lnk2'
$ cp -rl d d2; [ d/a -ef d2/a ] && echo linked
linked
$ cp -ls a b
cp: cannot make both hard and symbolic links
Try 'cp --help' for more information.
[exit 1]
$ cp -sv a sym; [ -L sym ] && echo link
'a' -> 'sym'
link
$ cp -s a d/sym
cp: d/sym: can make relative symbolic links only in current directory
[exit 1]
$ cp --remove-destination -v a new
removed 'new'
'a' -> 'new'
$ ln -s nowhere dang; cp a dang
cp: not writing through dangling symlink 'dang'
[exit 1]
$ cp --attributes-only a attr; cat attr; echo $?
0
$ cp /dev/null n; cat n; echo $?
0
$ cp /usr/bin/true t; ./t; echo $?
0
$ cp -z a b
cp: invalid option -- 'z'
Try 'cp --help' for more information.
[exit 1]
