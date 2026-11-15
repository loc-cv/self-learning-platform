# ls sort orders: names in code point order (C.UTF-8), -r, -X by extension, -v natural version
# order, --sort=width, -t and -S ties broken by name, --group-directories-first.
# tags: golden-verified
% mkdir o && cd o && touch File Z _u a.tar.gz afile b.tar c. file10 file9 file1.2 file1.10 é .x 'a b' A-1 a-1 1 10 9 v1.10.0 v1.9.0 v1.10.0~rc1 && mkdir zdir bdir
$ ls
 1    A-1    _u     a.tar.gz   bdir	  file1.2   v1.10.0	  zdir
 10   File  'a b'   afile      c.	  file10    v1.10.0~rc1   é
 9    Z      a-1    b.tar      file1.10   file9     v1.9.0
$ ls -1
1
10
9
A-1
File
Z
_u
'a b'
a-1
a.tar.gz
afile
b.tar
bdir
c.
file1.10
file1.2
file10
file9
v1.10.0
v1.10.0~rc1
v1.9.0
zdir
é
$ ls -r
 é	  v1.10.0~rc1   file10	   c.	   afile     'a b'   File   10
 zdir	  v1.10.0       file1.2    bdir    a.tar.gz   _u     A-1    1
 v1.9.0   file9         file1.10   b.tar   a-1	      Z      9
$ ls -X
 1    A-1    _u     afile    file9   c.        v1.10.0~rc1   a.tar.gz
 10   File  'a b'   bdir     zdir    v1.10.0   file1.10      b.tar
 9    Z      a-1    file10   é	     v1.9.0    file1.2
$ ls -Xr
 b.tar	    file1.10	  v1.10.0   zdir     bdir   'a b'   File   10
 a.tar.gz   v1.10.0~rc1   c.	    file9    afile   _u     A-1    1
 file1.2    v1.9.0	  é	    file10   a-1     Z	    9
$ ls -aX
 1    A-1    _u     afile    file9   .	  v1.10.0       file1.10   b.tar
 10   File  'a b'   bdir     zdir    ..   v1.9.0        file1.2    .x
 9    Z      a-1    file10   é	     c.   v1.10.0~rc1   a.tar.gz
$ ls -v
 1    A-1    a.tar.gz   a-1     c.	   file9    v1.10.0~rc1   _u
 9    File   afile      b.tar   file1.2    file10   v1.10.0	  é
 10   Z     'a b'       bdir    file1.10   v1.9.0   zdir
$ ls -av
 .    1    A-1	  a.tar.gz   a-1     c.         file9	 v1.10.0~rc1   _u
 ..   9    File   afile      b.tar   file1.2    file10	 v1.10.0       é
 .x   10   Z	 'a b'	     bdir    file1.10   v1.9.0	 zdir
$ ls -vr
 é      v1.10.0       file10	 file1.2   b.tar   afile      File   9
 _u     v1.10.0~rc1   file9	 c.	   a-1	   a.tar.gz   A-1    1
 zdir   v1.9.0	      file1.10	 bdir	  'a b'    Z	      10
$ ls --sort=version -1
1
9
10
A-1
File
Z
a.tar.gz
afile
'a b'
a-1
b.tar
bdir
c.
file1.2
file1.10
file9
file10
v1.9.0
v1.10.0~rc1
v1.10.0
zdir
_u
é
$ ls --sort=width
 1   é	  c.    File   zdir    file9    file1.2    file1.10
 9   10   A-1  'a b'   afile   file10   v1.10.0    v1.10.0~rc1
 Z   _u   a-1   bdir   b.tar   v1.9.0   a.tar.gz
$ ls --sort=width -r
 v1.10.0~rc1   v1.10.0	 file10   afile  'a b'	 A-1   10   9
 file1.10      file1.2	 file9	  zdir	  File	 c.    é    1
 a.tar.gz      v1.9.0	 b.tar	  bdir	  a-1	 _u    Z
$ ls --sort=extension -1
1
10
9
A-1
File
Z
_u
'a b'
a-1
afile
bdir
file10
file9
zdir
é
c.
v1.10.0
v1.9.0
v1.10.0~rc1
file1.10
file1.2
a.tar.gz
b.tar
$ ls --sort=none -d .
.
$ ls --group-directories-first
 bdir   10    File  'a b'       afile   file1.10   file9	 v1.9.0
 zdir   9     Z      a-1        b.tar   file1.2    v1.10.0	 é
 1      A-1   _u     a.tar.gz   c.      file10	   v1.10.0~rc1
$ ls --group-directories-first -X
 bdir   10    File  'a b'    file10   c.        v1.10.0~rc1   a.tar.gz
 zdir   9     Z      a-1     file9    v1.10.0   file1.10      b.tar
 1      A-1   _u     afile   é	      v1.9.0    file1.2
$ ls --group-directories-first -1 -r
zdir
bdir
é
v1.9.0
v1.10.0~rc1
v1.10.0
file9
file10
file1.2
file1.10
c.
b.tar
afile
a.tar.gz
a-1
'a b'
_u
Z
File
A-1
9
10
1
$ ls -p --group-directories-first
 bdir/	 10    File  'a b'	 afile	 file1.10   file9	  v1.9.0
 zdir/	 9     Z      a-1	 b.tar	 file1.2    v1.10.0	  é
 1	 A-1   _u     a.tar.gz	 c.	 file10     v1.10.0~rc1
#
# Equal times and sizes keep name order.
% cd .. && mkdir eq && cd eq && touch -d '2026-11-10 08:30:00' b c a && touch -d '2026-11-11 08:30:00' new && printf xx > bb && printf xx > aa && printf x > one && touch -d '2026-11-09 08:30:00' bb aa one
$ ls -t
new  a	b  c  aa  bb  one
$ ls -tr
one  bb  aa  c	b  a  new
$ ls -S
aa  bb	one  a	b  c  new
$ ls -Sr
new  c	b  a  one  bb  aa
$ ls -St
new  a	b  c  aa  bb  one
$ ls -tS
aa  bb	one  a	b  c  new
$ ls -t --sort=name
ls: invalid argument ‘name’ for ‘--sort’
Valid arguments are:
  - ‘none’
  - ‘time’
  - ‘size’
  - ‘extension’
  - ‘version’
  - ‘width’
Try 'ls --help' for more information.
[exit 1]
$ ls --sort=time -1
new
a
b
c
aa
bb
one
$ ls --sort=size -1
aa
bb
one
a
b
c
new
$ ls -l -t
total 12
-rw-r--r-- 1 student student 0 Nov 11 08:30 new
-rw-r--r-- 1 student student 0 Nov 10 08:30 a
-rw-r--r-- 1 student student 0 Nov 10 08:30 b
-rw-r--r-- 1 student student 0 Nov 10 08:30 c
-rw-r--r-- 1 student student 2 Nov  9 08:30 aa
-rw-r--r-- 1 student student 2 Nov  9 08:30 bb
-rw-r--r-- 1 student student 1 Nov  9 08:30 one
