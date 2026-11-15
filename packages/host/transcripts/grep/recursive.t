# grep: -r and -R, --include, --exclude, --exclude-dir. Real grep visits a directory's entries in
# the directory's own order (hash order on ext4), the simulator in sorted order: every directory
# here whose entries both produce output has one entry only.
# tags: golden-verified
% mkdir -p t/s/u m L D loop/sub p p2/r; printf 'foo\n' > t/s/u/x.log
% printf 'foo\n' > m/x.log; printf 'foo\n' > m/y.txt; printf 'bar\n' > m/z.txt
% ln -s ../t/s L/link; ln -s ../nowhere D/dangling; ln -s .. loop/sub/up; printf 'foo\n' > p/q
$ grep -r foo t
t/s/u/x.log:foo
$ grep -r foo t/
t/s/u/x.log:foo
$ cd t && grep -r foo; cd ..
s/u/x.log:foo
$ cd t && grep -rH foo s/u/x.log; cd ..
s/u/x.log:foo
$ grep -r foo t/s/u/x.log
foo
$ grep -rh foo t
foo
$ grep -rc foo t
t/s/u/x.log:1
$ grep -rl foo t
t/s/u/x.log
$ grep -rL foo t; echo $?
0
$ grep -r --include='*.log' foo m
m/x.log:foo
$ grep -r --include='*.txt' foo m
m/y.txt:foo
$ grep -r --exclude='*.txt' foo m
m/x.log:foo
$ grep -r --exclude='[xy]*' -c foo m
m/z.txt:0
[exit 1]
$ grep -r --include='*.log' --exclude='x*' foo m; echo $?
1
$ grep -r --exclude='*.txt' --include='y*' foo m
m/x.log:foo
m/y.txt:foo
$ grep -r --exclude-dir=u foo t; echo $?
1
$ grep -r --exclude-dir=s foo t; echo $?
1
$ grep -r --exclude-dir=u foo t/s/u; echo $?
1
$ grep -r --exclude-dir='u/' foo t; echo $?
1
$ grep -r --exclude=t foo t
t/s/u/x.log:foo
$ grep --include='*.txt' foo m/x.log m/y.txt
m/y.txt:foo
$ grep --exclude='*.log' foo m/x.log t/s/u/x.log; echo $?
1
$ printf 'x.log\n' > ex; grep -r --exclude-from=ex foo m t; echo $?
m/y.txt:foo
0
$ grep -r --exclude-from=nope foo m
grep: nope: No such file or directory
[exit 2]
$ grep -d recurse foo t
t/s/u/x.log:foo
$ grep -d skip foo t; echo $?
1
$ grep -r foo L; echo $?
1
$ grep -r foo L/link
L/link/u/x.log:foo
$ grep -R foo L
L/link/u/x.log:foo
$ grep -r foo D; echo $?
1
$ grep -R foo D; echo $?
grep: D/dangling: No such file or directory
2
$ grep -R foo loop; echo $?
grep: loop/sub/up: warning: recursive directory loop
1
$ grep -Rs foo loop; echo $?
1
$ grep -r foo - < m/y.txt
foo
$ grep -r foo nonexist
grep: nonexist: No such file or directory
[exit 2]
$ chmod 000 p/q p2/r; grep -r foo p p2; echo $?; chmod 755 p2/r; chmod 644 p/q
grep: p/q: Permission denied
grep: p2/r: Permission denied
2
$ chmod 000 p2/r; grep -rs foo p2; echo $?; chmod 755 p2/r
2
