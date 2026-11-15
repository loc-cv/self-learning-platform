# dir and vdir: ls in columns and in the long format, quoting with backslash escapes, also in a pipe.
# tags: golden-verified
% mkdir dd && cd dd && touch -d '2026-11-10 08:30:00' 'a b' plain x "it's" && mkdir sub && touch -d '2026-11-10 08:30:00' sub
$ dir
a\ b  it's  plain  sub	x
$ dir | cat
a\ b  it's  plain  sub	x
$ dir -1
a\ b
it's
plain
sub
x
$ dir -N
a b  it's  plain  sub  x
$ vdir
total 4
-rw-r--r-- 1 student student    0 Nov 10 08:30 a\ b
-rw-r--r-- 1 student student    0 Nov 10 08:30 it's
-rw-r--r-- 1 student student    0 Nov 10 08:30 plain
drwxr-xr-x 2 student student 4096 Nov 10 08:30 sub
-rw-r--r-- 1 student student    0 Nov 10 08:30 x
$ vdir | cat
total 4
-rw-r--r-- 1 student student    0 Nov 10 08:30 a\ b
-rw-r--r-- 1 student student    0 Nov 10 08:30 it's
-rw-r--r-- 1 student student    0 Nov 10 08:30 plain
drwxr-xr-x 2 student student 4096 Nov 10 08:30 sub
-rw-r--r-- 1 student student    0 Nov 10 08:30 x
$ vdir -1
a\ b
it's
plain
sub
x
$ dir -l
total 4
-rw-r--r-- 1 student student    0 Nov 10 08:30 a\ b
-rw-r--r-- 1 student student    0 Nov 10 08:30 it's
-rw-r--r-- 1 student student    0 Nov 10 08:30 plain
drwxr-xr-x 2 student student 4096 Nov 10 08:30 sub
-rw-r--r-- 1 student student    0 Nov 10 08:30 x
$ vdir -C
a\ b  it's  plain  sub	x
$ vdir -Q sub plain
-rw-r--r-- 1 student student    0 Nov 10 08:30 "plain"

"sub":
total 0
$ dir nope
dir: cannot access 'nope': No such file or directory
[exit 2]
$ vdir -z
vdir: invalid option -- 'z'
Try 'vdir --help' for more information.
[exit 2]
$ dir --help | head -3
Usage: dir [OPTION]... [FILE]...
List information about the FILEs (the current directory by default).
Sort entries alphabetically if none of -cftuvSUX nor --sort is specified.
