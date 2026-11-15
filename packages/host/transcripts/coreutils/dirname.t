# dirname: parent components, slashes, several names, -z, usage errors.
# tags: golden-verified
$ dirname /usr/bin/
/usr
$ dirname dir1/str dir2/str
dir1
dir2
$ dirname stdio.h
.
$ dirname / // /// '' a/ a//b// //a ///a /a . .. ../a
/
/
/
.
.
a
/
/
/
.
.
..
$ dirname -z a/b c | cat -v; echo
a^@.^@
$ dirname "a b/c d"
a b
$ dirname
dirname: missing operand
Try 'dirname --help' for more information.
[exit 1]
$ dirname -x
dirname: invalid option -- 'x'
Try 'dirname --help' for more information.
[exit 1]
$ dirname --help | head -2
Usage: dirname [OPTION] NAME...
Output each NAME with its last non-slash component and trailing slashes
