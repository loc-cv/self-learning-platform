# mkdir: plain, parents, modes, verbose, errors.
# tags: golden-verified
$ mkdir
mkdir: missing operand
Try 'mkdir --help' for more information.
[exit 1]
$ mkdir a; mkdir a
mkdir: cannot create directory ‘a’: File exists
[exit 1]
$ mkdir -v b c/d e
mkdir: created directory 'b'
mkdir: cannot create directory ‘c/d’: No such file or directory
mkdir: created directory 'e'
[exit 1]
$ mkdir -pv c/d/e f
mkdir: created directory 'c'
mkdir: created directory 'c/d'
mkdir: created directory 'c/d/e'
mkdir: created directory 'f'
$ mkdir -p a; echo $?
0
# A file in the way, as an ancestor and as the final component.
% printf 'x\n' > file
$ mkdir -p file/x
mkdir: cannot create directory ‘file’: Not a directory
[exit 1]
$ mkdir file/x
mkdir: cannot create directory ‘file/x’: Not a directory
[exit 1]
$ mkdir -p file
mkdir: cannot create directory ‘file’: File exists
[exit 1]
# Modes: -m is applied exactly, not through the umask; parents made by -p keep the default.
$ mkdir -m 700 -v g; mkdir -m u=rwx,go= h; mkdir -m bad i
mkdir: created directory 'g'
mkdir: invalid mode ‘bad’
[exit 1]
$ mkdir -m 999 i
mkdir: invalid mode ‘999’
[exit 1]
$ mkdir -m 777 m777 && [ -w m777 ] && echo writable
writable
$ mkdir -pm 700 p1/p2 && [ -d p1/p2 ] && echo made
made
$ chmod -v u+ g h m777 p1 p1/p2
mode of 'g' retained as 0700 (rwx------)
mode of 'h' retained as 0700 (rwx------)
mode of 'm777' retained as 0777 (rwxrwxrwx)
mode of 'p1' retained as 0755 (rwxr-xr-x)
mode of 'p1/p2' retained as 0700 (rwx------)
$ mkdir -m 2755 s; mkdir -m +t t1; mkdir -m g+s t2; mkdir -m 4777 t3; chmod -v u+ s t1 t2 t3
mode of 's' retained as 2755 (rwxr-sr-x)
mode of 't1' retained as 1755 (rwxr-xr-t)
mode of 't2' retained as 2777 (rwxrwsrwx)
mode of 't3' retained as 4777 (rwsrwxrwx)
# Permission denied in an unwritable directory, with and without -p.
% mkdir ro; chmod 555 ro
$ mkdir ro/x
mkdir: cannot create directory ‘ro/x’: Permission denied
[exit 1]
$ mkdir -p ro/y/z
mkdir: cannot create directory ‘ro/y’: Permission denied
[exit 1]
$ mkdir ""
mkdir: cannot create directory ‘’: No such file or directory
[exit 1]
$ mkdir x/; mkdir -p y/./z/../w; [ -d y/w ] && echo ok
ok
$ mkdir -v ./b/../k
mkdir: created directory './b/../k'
$ mkdir -pv ./q/../r
mkdir: created directory './q'
mkdir: created directory './q/../r'
$ mkdir -p /tmp; echo $?
0
$ mkdir /tmp
mkdir: cannot create directory ‘/tmp’: File exists
[exit 1]
$ mkdir -z
mkdir: invalid option -- 'z'
Try 'mkdir --help' for more information.
[exit 1]
$ mkdir --mode
mkdir: option '--mode' requires an argument
Try 'mkdir --help' for more information.
[exit 1]
