# chown as an ordinary user: owner and group specs, -v/-c, -R, --from, --reference, errors.
# Giving a file away needs root (Operation not permitted); changing the group to one of one's own works.
# tags: golden-verified
$ chown
chown: missing operand
Try 'chown --help' for more information.
[exit 1]
$ chown 1000
chown: missing operand after ‘1000’
Try 'chown --help' for more information.
[exit 1]
$ chown --reference=/etc/hostname
chown: missing operand
Try 'chown --help' for more information.
[exit 1]
% touch a; mkdir d; touch d/x
$ chown -v 1000 a; echo $?
ownership of 'a' retained as student
0
$ chown -v 1000:1000 a; chown -c 1000 a; chown -v :1000 a; chown -v +1000 a
ownership of 'a' retained as student:student
group of 'a' retained as student
ownership of 'a' retained as student
$ chown -v root a
chown: changing ownership of 'a': Operation not permitted
failed to change ownership of 'a' from student to root
[exit 1]
$ chown root a
chown: changing ownership of 'a': Operation not permitted
[exit 1]
$ chown -f root a; echo $?
1
$ chown -v :root a
chown: changing group of 'a': Operation not permitted
failed to change ownership of 'a' from student:student to :root
[exit 1]
$ chown -v :0 a
chown: changing group of 'a': Operation not permitted
failed to change group of 'a' from student to 0
[exit 1]
$ chown -v :sudo a
changed ownership of 'a' from student:student to :sudo
$ chown -c :1000 a; chown -c :1000 a
changed group of 'a' from sudo to 1000
$ chown -v 1000:sudo a; chown -v 1000:1000 a
changed ownership of 'a' from student:student to :sudo
changed ownership of 'a' from student:sudo to 1000:1000
$ chown -v nosuch a
chown: invalid user: ‘nosuch’
[exit 1]
$ chown -v :nosuch a
chown: invalid group: ‘:nosuch’
[exit 1]
$ chown -v nosuch:sudo a
chown: invalid user: ‘nosuch:sudo’
[exit 1]
$ chown -v 1000: a
chown: invalid spec: ‘1000:’
[exit 1]
$ chown -v 99999 a
chown: changing ownership of 'a': Operation not permitted
failed to change ownership of 'a' from student to 99999
[exit 1]
$ chown -v 1000 nope
chown: cannot access 'nope': No such file or directory
failed to change ownership of 'nope' to 1000
[exit 1]
$ chown 1000 nope
chown: cannot access 'nope': No such file or directory
[exit 1]
$ chown -Rv 1000 d
ownership of 'd/x' retained as student
ownership of 'd' retained as student
$ chown -R root d
chown: changing ownership of 'd/x': Operation not permitted
chown: changing ownership of 'd': Operation not permitted
[exit 1]
$ chown -vR :sudo d; chown -cR :1000 d
changed ownership of 'd/x' from student:student to :sudo
changed ownership of 'd' from student:student to :sudo
changed group of 'd/x' from sudo to 1000
changed group of 'd' from sudo to 1000
$ chown -v "" a
ownership of 'a' retained
$ chown -v : a
ownership of 'a' retained
$ chown -v --from=root 1000 a
ownership of 'a' retained as student
$ chown -v --from=:1000 :sudo a; chown --from=1000 :1000 a; echo $?
changed ownership of 'a' from student:student to :sudo
0
$ chown --from=nosuch 1000 a
chown: invalid user: ‘nosuch’
[exit 1]
$ chown --reference=/etc/passwd a
chown: changing ownership of 'a': Operation not permitted
[exit 1]
$ chown -v --reference=a a
ownership of 'a' retained as student:student
$ chown --reference=nope a
chown: failed to get attributes of 'nope': No such file or directory
[exit 1]
$ chown -v root /etc/passwd
chown: changing ownership of '/etc/passwd': Operation not permitted
failed to change ownership of '/etc/passwd' from root to root
[exit 1]
$ chown -R --preserve-root 1000 /
chown: it is dangerous to operate recursively on '/'
chown: use --no-preserve-root to override this failsafe
[exit 1]
$ chown -R --dereference 1000 d
chown: -R --dereference requires either -H or -L
[exit 1]
$ chown -z a
chown: invalid option -- 'z'
Try 'chown --help' for more information.
[exit 1]
# Symbolic links: the target is changed, unless -h; -R does not follow links by default.
# (chown -v on a dangling link prints uninitialized stat data upstream, so it is not captured.)
% ln -s a sl; ln -s nowhere dl
$ chown -v :sudo sl; chown -c :1000 sl
changed ownership of 'sl' from student:student to :sudo
changed group of 'sl' from sudo to 1000
$ chown 1000 dl
chown: cannot dereference 'dl': No such file or directory
[exit 1]
$ chown -hv "" sl
ownership of 'sl' retained
# An unreadable directory is reported and left as it is; its parent still changes.
% mkdir -p e/f; chmod 000 e/f
$ chown -Rv :1000 e
chown: cannot read directory 'e/f': Permission denied
failed to change group of 'e/f' to 1000
group of 'e' retained as student
[exit 1]
% chmod 700 e/f
