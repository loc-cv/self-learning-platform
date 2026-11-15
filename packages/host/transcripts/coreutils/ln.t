# ln: hard and symbolic links, into directories, -f, -n, -T, -t, -r, errors.
# tags: golden-verified
$ ln
ln: missing file operand
Try 'ln --help' for more information.
[exit 1]
% printf 'hi\n' > a; mkdir d
$ ln -v a b; ln a b
'b' => 'a'
ln: failed to create hard link 'b': File exists
[exit 1]
$ ln -sv a s; ln -s a s
's' -> 'a'
ln: failed to create symbolic link 's': File exists
[exit 1]
$ ln -sfv b s; cat s
's' -> 'b'
hi
$ ln -s /etc/hosts; [ -L hosts ] && echo link
link
$ ln a
ln: failed to create hard link './a': File exists
[exit 1]
$ ln -sv ../a d; ln -sv ../a d/
'd/a' -> '../a'
ln: failed to create symbolic link 'd/a': File exists
[exit 1]
$ ln d dl
ln: d: hard link not allowed for directory
[exit 1]
$ ln nope x
ln: failed to access 'nope': No such file or directory
[exit 1]
$ ln -s nope x; echo $?
0
$ ln -sv a b c
ln: target 'c': No such file or directory
[exit 1]
$ ln -v a b d
ln: failed to create hard link 'd/a': File exists
'd/b' => 'b'
[exit 1]
$ ln -sfv a d
'd/a' -> 'a'
% ln -s d sd
$ ln -sfv a sd; [ -L d/a ] && echo inside
'sd/a' -> 'a'
inside
$ ln -sfnv a sd; cat sd
'sd' -> 'a'
hi
$ ln -sTv a d
ln: failed to create symbolic link 'd': File exists
[exit 1]
$ ln -sv -t d ../b
ln: failed to create symbolic link 'd/b': File exists
[exit 1]
$ ln -f a a
ln: 'a' and 'a' are the same file
[exit 1]
$ ln -sf a a
ln: 'a' and 'a' are the same file
[exit 1]
% mkdir ro; chmod 555 ro
$ ln -s a ro/x
ln: failed to create symbolic link 'ro/x': Permission denied
[exit 1]
$ ln a ro/
ln: failed to create hard link 'ro/a' => 'a': Permission denied
[exit 1]
$ ln -sr a d/rel; echo $?; cat d/rel
0
hi
$ ln -sv a "my link"
'my link' -> 'a'
$ ln /etc/passwd pw
ln: failed to create hard link 'pw' => '/etc/passwd': Operation not permitted
[exit 1]
$ ln -f a b; ln -fv a b
'b' => 'a'
$ ln -s a ""
ln: failed to create symbolic link '': No such file or directory
[exit 1]
$ ln -s a nod/x
ln: failed to create symbolic link 'nod/x': No such file or directory
[exit 1]
$ ln a nod/x
ln: failed to create hard link 'nod/x' => 'a': No such file or directory
[exit 1]
$ ln a nod/
ln: failed to create hard link 'nod/' => 'a': No such file or directory
[exit 1]
$ ln -s a nod/
ln: failed to create symbolic link 'nod/': No such file or directory
[exit 1]
$ ln -T a b c
ln: extra operand 'c'
Try 'ln --help' for more information.
[exit 1]
$ ln -T a
ln: missing destination file operand after 'a'
Try 'ln --help' for more information.
[exit 1]
$ ln -t nod a
ln: failed to access 'nod': No such file or directory
[exit 1]
$ ln -t a b
ln: target 'a' is not a directory
[exit 1]
$ ln -s a "" b
ln: target 'b': Not a directory
[exit 1]
$ ln -r a r
ln: cannot do --relative without --symbolic
[exit 1]
$ ln -t d -T a b
ln: cannot combine --target-directory and --no-target-directory
[exit 1]
# Hard links to a symbolic link, or (-L) to what it names.
$ ln -fv s s2; [ -L s2 ] && echo symlink
's2' => 's'
symlink
$ ln -Lv s s3; [ -L s3 ] || echo regular
's3' => 's'
regular
% mkdir e; ln -s x e/l
$ ln -f e/l e
ln: 'e/l' and 'e/l' are the same file
[exit 1]
$ ln -sfv y e; cat e/y
'e/y' -> 'y'
cat: e/y: Too many levels of symbolic links
[exit 1]
$ ln -sfv /etc e/
'e/etc' -> '/etc'
$ ln -fv a e/l; cat e/l
'e/l' => 'a'
hi
$ ln -srv a e/up; cat e/up
'e/up' -> '../a'
hi
