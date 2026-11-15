# basename: last components, suffixes, -a/-s/-z, slashes, usage errors.
# tags: golden-verified
$ basename /usr/bin/sort
sort
$ basename include/stdio.h .h
stdio
$ basename -s .h include/stdio.h
stdio
$ basename -a any/str1 any/str2
str1
str2
$ basename -as .c a.c b/c.c d.h
a
c
d.h
$ basename --suffix=.c a.c
a
$ basename / // a/b/ a//b//
basename: extra operand ‘a/b/’
Try 'basename --help' for more information.
[exit 1]
$ basename -a / // a/b/ a//b// ''
/
/
b
b

$ basename x.h .h; basename .h .h; basename /.h .h
x
.h
.h
$ basename usr/ r/; basename / /
usr
/
$ basename "a b/c d"
c d
$ basename -z a/b | cat -v; echo
b^@
$ basename -az a b | cat -v; echo
a^@b^@
$ basename
basename: missing operand
Try 'basename --help' for more information.
[exit 1]
$ basename a b c
basename: extra operand ‘c’
Try 'basename --help' for more information.
[exit 1]
$ basename -x
basename: invalid option -- 'x'
Try 'basename --help' for more information.
[exit 1]
$ basename --help | head -2
Usage: basename NAME [SUFFIX]
  or:  basename OPTION... NAME...
