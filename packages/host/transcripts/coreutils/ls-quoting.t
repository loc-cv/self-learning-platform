# ls quoting of file names: shell-escape quoting on a terminal with the alignment space for
# unquoted names, literal names in a pipe, -b, -Q, -N, -q, --show-control-chars, every
# --quoting-style, QUOTING_STYLE, the characters -F adds, and directory headers.
# tags: golden-verified
% mkdir q && cd q && printf x > 'a b' && printf x > "it's" && printf x > 'q"x' && printf x > 'b\s' && printf x > "s'q\"d" && printf x > 'x*y' && printf x > $'tab\tx' && printf x > $'n\nl'
% printf x > $'\001' && printf x > $'c\001d' && printf x > 'ü x' && printf x > '{' && printf x > '#a' && printf x > 'a#' && printf x > '~' && printf x > 'b~c' && printf x > '!x' && printf x > 'e=f'
% printf x > '%x' && printf x > 'a,b+c' && printf x > 'a^b' && printf x > plain && printf x > é && printf x > $'a\n' && printf x > $'\'x' && printf x > $'d\'\te' && printf x > $'\302\205z' && printf x > 'a?b' && printf x > '$v'
$ ls
''$'\001'  'a'$'\n'  'b\s'	      'n'$'\n''l'    '{'
'!x'	   'a b'      b~c	       plain	     '~'
'#a'	    a#	     'c'$'\001''d'    'q"x'	     ''$'\302\205''z'
'$v'	    a,b+c    'd'\'''$'\t''e'  's'\''q"d'      é
 %x	   'a?b'     'e=f'	      'tab'$'\t''x'  'ü x'
"'x"	   'a^b'     "it's"	      'x*y'
$ ls -1
''$'\001'
'!x'
'#a'
'$v'
%x
"'x"
'a'$'\n'
'a b'
a#
a,b+c
'a?b'
'a^b'
'b\s'
b~c
'c'$'\001''d'
'd'\'''$'\t''e'
'e=f'
"it's"
'n'$'\n''l'
plain
'q"x'
's'\''q"d'
'tab'$'\t''x'
'x*y'
'{'
'~'
''$'\302\205''z'
é
'ü x'
$ ls | cat

!x
\#a
$v
%x
'x
a

a b
a#
a,b+c
a?b
a^b
b\s
b~c
cd
d'	e
e=f
it's
n
l
plain
q"x
s'q"d
tab	x
x*y
{
~
z
é
ü x
$ ls -x
''$'\001'    '!x'    '#a'	       '$v'		 %x	       "'x"
'a'$'\n'     'a b'    a#	        a,b+c		'a?b'	       'a^b'
'b\s'	      b~c    'c'$'\001''d'     'd'\'''$'\t''e'	'e=f'	       "it's"
'n'$'\n''l'   plain  'q"x'	       's'\''q"d'	'tab'$'\t''x'  'x*y'
'{'	     '~'     ''$'\302\205''z'   é		'ü x'
$ ls -m
''$'\001', '!x', '#a', '$v', %x, "'x", 'a'$'\n', 'a b', a#, a,b+c, 'a?b', 'a^b',
'b\s', b~c, 'c'$'\001''d', 'd'\'''$'\t''e', 'e=f', "it's", 'n'$'\n''l', plain,
'q"x', 's'\''q"d', 'tab'$'\t''x', 'x*y', '{', '~', ''$'\302\205''z', é, 'ü x'
$ ls -C -w 0
''$'\001'  '!x'  '#a'  '$v'  %x  "'x"  'a'$'\n'  'a b'  a#  a,b+c  'a?b'  'a^b'  'b\s'  b~c  'c'$'\001''d'  'd'\'''$'\t''e'  'e=f'  "it's"  'n'$'\n''l'  plain  'q"x'  's'\''q"d'  'tab'$'\t''x'  'x*y'  '{'  '~'  ''$'\302\205''z'  é  'ü x'
$ ls -b
\\001  $v  a\n	a,b+c  b\\s    d'\te  n\nl   s'q"d   {		é
!x    %x  a\ b	a?b    b~c     e=f    plain  tab\tx  ~		ü\ x
\#a    'x  a#	a^b    c\001d  it's   q"x    x*y     \302\205z
$ ls -Q
"\001"	"%x"   "a#"	"b\\s"	  "e=f"    "q\"x"    "{"	  "ü x"
"!x"	"'x"   "a,b+c"	"b~c"	  "it's"   "s'q\"d"  "~"
"#a"	"a\n"  "a?b"	"c\001d"  "n\nl"   "tab\tx"  "\302\205z"
"$v"	"a b"  "a^b"	"d'\te"   "plain"  "x*y"     "é"
$ ls -N
?   #a	%x  a?	 a#	a?b  b\s  c?d	e=f   n?l    q"x    tab?x  {  ?z  ü x
!x  $v	'x  a b  a,b+c	a^b  b~c  d'?e	it's  plain  s'q"d  x*y    ~  é
$ ls -q | cat
?
!x
\#a
$v
%x
'x
a?
a b
a#
a,b+c
a?b
a^b
b\s
b~c
c?d
d'?e
e=f
it's
n?l
plain
q"x
s'q"d
tab?x
x*y
{
~
?z
é
ü x
$ ls -q
''$'\001'  'a'$'\n'  'b\s'	      'n'$'\n''l'    '{'
'!x'	   'a b'      b~c	       plain	     '~'
'#a'	    a#	     'c'$'\001''d'    'q"x'	     ''$'\302\205''z'
'$v'	    a,b+c    'd'\'''$'\t''e'  's'\''q"d'      é
 %x	   'a?b'     'e=f'	      'tab'$'\t''x'  'ü x'
"'x"	   'a^b'     "it's"	      'x*y'
$ ls -N --show-control-chars | cat -A
^A$
!x$
\#a$
$v$
%x$
'x$
a$
$
a b$
a#$
a,b+c$
a?b$
a^b$
b\s$
b~c$
c^Ad$
d'^Ie$
e=f$
it's$
n$
l$
plain$
q"x$
s'q"d$
tab^Ix$
x*y$
{$
~$
M-BM-^Ez$
M-CM-)$
M-CM-< x$
$ ls -1 --show-control-chars | cat -A
^A$
!x$
\#a$
$v$
%x$
'x$
a$
$
a b$
a#$
a,b+c$
a?b$
a^b$
b\s$
b~c$
c^Ad$
d'^Ie$
e=f$
it's$
n$
l$
plain$
q"x$
s'q"d$
tab^Ix$
x*y$
{$
~$
M-BM-^Ez$
M-CM-)$
M-CM-< x$
$ ls -1 --quoting-style=literal
?
!x
\#a
$v
%x
'x
a?
a b
a#
a,b+c
a?b
a^b
b\s
b~c
c?d
d'?e
e=f
it's
n?l
plain
q"x
s'q"d
tab?x
x*y
{
~
?z
é
ü x
$ ls -1 --quoting-style=shell
?
'!x'
'#a'
'$v'
%x
"'x"
'a?'
'a b'
a#
a,b+c
'a?b'
'a^b'
'b\s'
b~c
c?d
'd'\''?e'
'e=f'
"it's"
'n?l'
plain
'q"x'
's'\''q"d'
'tab?x'
'x*y'
'{'
'~'
?z
é
'ü x'
$ ls -1 --quoting-style=shell-always
'?'
'!x'
'#a'
'$v'
'%x'
"'x"
'a?'
'a b'
'a#'
'a,b+c'
'a?b'
'a^b'
'b\s'
'b~c'
'c?d'
'd'\''?e'
'e=f'
"it's"
'n?l'
'plain'
'q"x'
's'\''q"d'
'tab?x'
'x*y'
'{'
'~'
'?z'
'é'
'ü x'
$ ls -1 --quoting-style=shell-escape
''$'\001'
'!x'
'#a'
'$v'
%x
"'x"
'a'$'\n'
'a b'
a#
a,b+c
'a?b'
'a^b'
'b\s'
b~c
'c'$'\001''d'
'd'\'''$'\t''e'
'e=f'
"it's"
'n'$'\n''l'
plain
'q"x'
's'\''q"d'
'tab'$'\t''x'
'x*y'
'{'
'~'
''$'\302\205''z'
é
'ü x'
$ ls -1 --quoting-style=shell-escape-always
''$'\001'
'!x'
'#a'
'$v'
'%x'
"'x"
'a'$'\n'
'a b'
'a#'
'a,b+c'
'a?b'
'a^b'
'b\s'
'b~c'
'c'$'\001''d'
'd'\'''$'\t''e'
'e=f'
"it's"
'n'$'\n''l'
'plain'
'q"x'
's'\''q"d'
'tab'$'\t''x'
'x*y'
'{'
'~'
''$'\302\205''z'
'é'
'ü x'
$ ls -1 --quoting-style=c
"\001"
"!x"
"#a"
"$v"
"%x"
"'x"
"a\n"
"a b"
"a#"
"a,b+c"
"a?b"
"a^b"
"b\\s"
"b~c"
"c\001d"
"d'\te"
"e=f"
"it's"
"n\nl"
"plain"
"q\"x"
"s'q\"d"
"tab\tx"
"x*y"
"{"
"~"
"\302\205z"
"é"
"ü x"
$ ls -1 --quoting-style=c-maybe
"\001"
!x
\#a
$v
%x
'x
"a\n"
a b
a#
a,b+c
a?b
a^b
b\s
b~c
"c\001d"
"d'\te"
e=f
it's
"n\nl"
plain
"q\"x"
"s'q\"d"
"tab\tx"
x*y
{
~
"\302\205z"
é
ü x
$ ls -1 --quoting-style=escape
\\001
!x
\#a
$v
%x
'x
a\n
a\ b
a#
a,b+c
a?b
a^b
b\\s
b~c
c\001d
d'\te
e=f
it's
n\nl
plain
q"x
s'q"d
tab\tx
x*y
{
~
\\302\205z
é
ü\ x
$ ls -1 --quoting-style=locale
‘\001’
‘!x’
‘#a’
‘$v’
‘%x’
‘'x’
‘a\n’
‘a b’
‘a#’
‘a,b+c’
‘a?b’
‘a^b’
‘b\\s’
‘b~c’
‘c\001d’
‘d'\te’
‘e=f’
‘it's’
‘n\nl’
‘plain’
‘q"x’
‘s'q"d’
‘tab\tx’
‘x*y’
‘{’
‘~’
‘\302\205z’
‘é’
‘ü x’
$ ls -1 --quoting-style=clocale
‘\001’
‘!x’
‘#a’
‘$v’
‘%x’
‘'x’
‘a\n’
‘a b’
‘a#’
‘a,b+c’
‘a?b’
‘a^b’
‘b\\s’
‘b~c’
‘c\001d’
‘d'\te’
‘e=f’
‘it's’
‘n\nl’
‘plain’
‘q"x’
‘s'q"d’
‘tab\tx’
‘x*y’
‘{’
‘~’
‘\302\205z’
‘é’
‘ü x’
$ ls --quoting-style=shell
 ?    '$v'  'a?'    a,b+c  'b\s'  'd'\''?e'  'n?l'   's'\''q"d'  '{'   é
'!x'   %x   'a b'  'a?b'    b~c   'e=f'       plain  'tab?x'	 '~'  'ü x'
'#a'  "'x"   a#    'a^b'    c?d   "it's"     'q"x'   'x*y'	  ?z
$ ls --quoting-style=c-maybe
"\001"	 %x     a#      b\s	  e=f	 "q\"x"     {		 ü x
 !x	 'x     a,b+c   b~c	  it's	 "s'q\"d"   ~
 #a	"a\n"   a?b    "c\001d"  "n\nl"  "tab\tx"  "\302\205z"
 $v	 a b    a^b    "d'\te"	  plain   x*y	    é
$ ls --quoting-style=sh -d plain 'a b'
ls: ambiguous argument ‘sh’ for ‘--quoting-style’
Valid arguments are:
  - ‘literal’
  - ‘shell’
  - ‘shell-always’
  - ‘shell-escape’
  - ‘shell-escape-always’
  - ‘c’
  - ‘c-maybe’
  - ‘escape’
  - ‘locale’
  - ‘clocale’
Try 'ls --help' for more information.
[exit 1]
$ ls -1 -b | cat
\\001
!x
\#a
$v
%x
'x
a\n
a\ b
a#
a,b+c
a?b
a^b
b\\s
b~c
c\001d
d'\te
e=f
it's
n\nl
plain
q"x
s'q"d
tab\tx
x*y
{
~
\\302\205z
é
ü\ x
$ QUOTING_STYLE=literal ls
?   #a	%x  a?	 a#	a?b  b\s  c?d	e=f   n?l    q"x    tab?x  {  ?z  ü x
!x  $v	'x  a b  a,b+c	a^b  b~c  d'?e	it's  plain  s'q"d  x*y    ~  é
$ QUOTING_STYLE=c ls -1 | cat
"\001"
"!x"
"#a"
"$v"
"%x"
"'x"
"a\n"
"a b"
"a#"
"a,b+c"
"a?b"
"a^b"
"b\\s"
"b~c"
"c\001d"
"d'\te"
"e=f"
"it's"
"n\nl"
"plain"
"q\"x"
"s'q\"d"
"tab\tx"
"x*y"
"{"
"~"
"\302\205z"
"é"
"ü x"
$ QUOTING_STYLE=escape ls -N -1 plain 'a b'
a b
plain
$ QUOTING_STYLE=bogus ls -d plain
ls: ignoring invalid value of environment variable QUOTING_STYLE: ‘bogus’
plain
#
# Long listings align unquoted names too; link targets are quoted but not padded.
% ln -s 'a b' lnk && ln -s plain lnk2
$ ls -l --time-style=+ plain 'a b' lnk lnk2 "it's"
-rw-r--r-- 1 student student 1  'a b'
-rw-r--r-- 1 student student 1  "it's"
lrwxrwxrwx 1 student student 3   lnk -> 'a b'
lrwxrwxrwx 1 student student 5   lnk2 -> plain
-rw-r--r-- 1 student student 1   plain
$ ls -ld --time-style=+ plain lnk2
lrwxrwxrwx 1 student student 5  lnk2 -> plain
-rw-r--r-- 1 student student 1  plain
#
# -F and --file-type quote the indicator characters in names.
% cd .. && mkdir ind && cd ind && printf x > 'p*q' && printf x > 'p=q' && printf x > 'p>q' && printf x > 'p@q' && printf x > 'p|q' && printf x > pq
$ ls
'p*q'  'p=q'  'p>q'   p@q   pq	'p|q'
$ ls -F
'p*q'  'p=q'  'p>q'  'p@q'   pq  'p|q'
$ ls --file-type
'p*q'  'p=q'  'p>q'  'p@q'   pq  'p|q'
$ ls -b
p*q  p=q  p>q  p@q  pq	p|q
$ ls -b -F
p*q  p\=q  p\>q  p\@q  pq  p\|q
$ ls -b --file-type
p\*q  p\=q  p\>q  p\@q	pq  p\|q
$ ls -Q -F
"p*q"  "p\=q"  "p\>q"  "p\@q"  "pq"  "p\|q"
$ ls -N -F
p*q  p=q  p>q  p@q  pq	p|q
$ ls --quoting-style=c-maybe -F
 p*q  "p=q"  "p>q"  "p@q"   pq	"p|q"
#
# Directory headers quote `:` too.
% cd .. && mkdir hd && cd hd && mkdir 'd i r' 'c:d' plain
$ ls
 c:d  'd i r'   plain
$ ls -R
.:
 c:d  'd i r'   plain

'./c:d':

'./d i r':

./plain:
$ ls -bR
.:
c:d  d\ i\ r  plain

./c\:d:

./d i r:

./plain:
$ ls -QR
".":
"c:d"  "d i r"	"plain"

"./c\:d":

"./d i r":

"./plain":
$ ls -NR
.:
c:d  d i r  plain

./c:d:

./d i r:

./plain:
$ ls -R | cat
.:
c:d
d i r
plain

./c:d:

./d i r:

./plain:
$ ls 'c:d' 'd i r'
'c:d':

'd i r':
$ ls -b 'c:d' 'd i r'
c\:d:

d i r:
