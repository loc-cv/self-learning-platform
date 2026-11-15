# mv: rename, move into directories, overwrite rules, -n, -u, -T, -t, errors.
# tags: golden-verified
$ mv
mv: missing file operand
Try 'mv --help' for more information.
[exit 1]
$ mv a
mv: missing destination file operand after 'a'
Try 'mv --help' for more information.
[exit 1]
% printf 'hi\n' > a; mkdir d e; touch b c
$ mv -v a x; mv -v x a
renamed 'a' -> 'x'
renamed 'x' -> 'a'
$ mv a a
mv: 'a' and 'a' are the same file
[exit 1]
$ mv -v a d; mv -v d/a .
renamed 'a' -> 'd/a'
renamed 'd/a' -> './a'
$ mv nope z
mv: cannot stat 'nope': No such file or directory
[exit 1]
$ mv a b c
mv: target 'c': Not a directory
[exit 1]
$ mv -v b c d
renamed 'b' -> 'd/b'
renamed 'c' -> 'd/c'
$ mv d e; mv -v e/d .
renamed 'e/d' -> './d'
$ mv -v a d/; mv d/a ./a
renamed 'a' -> 'd/a'
$ mkdir -p f/a; mv a f
mv: cannot overwrite directory 'f/a' with non-directory
[exit 1]
$ touch g; mv d g
mv: cannot overwrite non-directory 'g' with directory 'd'
[exit 1]
$ mv -T a d
mv: cannot overwrite directory 'd' with non-directory
[exit 1]
$ mkdir -p h/d; touch h/d/x; mv d h
mv: cannot overwrite 'h/d': Directory not empty
[exit 1]
$ mv d d/sub
mv: cannot move 'd' to a subdirectory of itself, 'd/sub'
[exit 1]
$ mv d d
mv: cannot move 'd' to a subdirectory of itself, 'd/d'
[exit 1]
$ mv d/ d2; mv d2/ d; echo $?
0
$ mv a/ z
mv: cannot stat 'a/': Not a directory
[exit 1]
$ mv -n a g
mv: not replacing 'g'
[exit 1]
$ mv -n -v a g
mv: not replacing 'g'
[exit 1]
$ mv -t d a -v; mv -t nod a
renamed 'a' -> 'd/a'
mv: target directory 'nod': No such file or directory
[exit 1]
$ mv -vf d/a a
renamed 'd/a' -> 'a'
$ mkdir ro; touch ro/f; chmod 555 ro; mv ro/f ./rf
mv: cannot move 'ro/f' to './rf': Permission denied
[exit 1]
$ mv a ro/
mv: cannot move 'a' to 'ro/a': Permission denied
[exit 1]
% chmod 755 ro
# A write-protected destination is replaced without a question when standard input is not a terminal.
$ touch p; chmod 444 p; mv a p < /dev/null; echo $?; cat p
0
hi
$ ln -s p sl; mv sl sl2; mv -v sl2 d; [ -L d/sl2 ] && echo link
renamed 'sl2' -> 'd/sl2'
link
$ mv . x
mv: cannot move '.' to 'x': Device or resource busy
[exit 1]
$ mv .. x
mv: cannot move '..' to 'x': Device or resource busy
[exit 1]
$ mv p p2 p3
mv: target 'p3': No such file or directory
[exit 1]
$ mv -T p
mv: missing destination file operand after 'p'
Try 'mv --help' for more information.
[exit 1]
$ mv -t . -T p q
mv: cannot combine --target-directory (-t) and --no-target-directory (-T)
[exit 1]
$ mv -t nod p
mv: target directory 'nod': No such file or directory
[exit 1]
$ mv -t p q
mv: target directory 'p': Not a directory
[exit 1]
# --update: an older source does not replace a newer destination.
$ touch -d 2026-01-01 old; touch -d 2026-06-01 new; mv -u -v old new; echo $?; [ -e old ] && echo kept
0
kept
$ mv -v --update=none old new; echo $?
0
$ mv --update=x old new
mv: invalid argument ‘x’ for ‘--update’
Valid arguments are:
  - ‘all’
  - ‘none’
  - ‘older’
Try 'mv --help' for more information.
[exit 1]
$ mv -v --update=all old new
renamed 'old' -> 'new'
% touch n2; ln n2 hl
$ mv n2 hl
mv: 'n2' and 'hl' are the same file
[exit 1]
$ ln -s hl sl; mv sl hl
mv: 'sl' and 'hl' are the same file
[exit 1]
$ mv --strip-trailing-slashes hl/ y
mv: cannot move 'hl' to 'y': Not a directory
[exit 1]
$ mkdir dd; mv -v dd/ ee/
renamed 'dd/' -> 'ee/'
$ mv -v --no-copy ee ff
renamed 'ee' -> 'ff'
$ mv -v ff/ ff/x
mv: cannot move 'ff/' to a subdirectory of itself, 'ff/x'
[exit 1]
$ mv -v ./ff ../outside-not-allowed/ff
mv: cannot move './ff' to '../outside-not-allowed/ff': No such file or directory
[exit 1]
