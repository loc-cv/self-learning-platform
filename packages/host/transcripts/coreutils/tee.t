# tee: copying to standard output and files, appending, a file named "-", files that cannot be
# written, pipelines.
# tags: golden-verified
$ echo hi | tee t1 t2
hi
$ cat t1 t2
hi
hi
$ echo more | tee -a t1
more
$ cat t1
hi
more
$ echo w | tee
w
$ echo q | tee -; cat ./-
q
q
$ echo a | tee t6 t6; cat t6
a
a
$ printf '1\n2\n3\n' | tee t7 | head -1; cat t7
1
1
2
3
$ echo x | tee /nonexist/f t3; echo "status $?"; cat t3
tee: /nonexist/f: No such file or directory
x
status 1
x
$ echo y | tee /tmp
tee: /tmp: Is a directory
y
[exit 1]
$ chmod 444 t3; echo z | tee t3 t4; cat t4
tee: t3: Permission denied
z
z
$ echo ok | tee -i t8 > /dev/null; cat t8
ok
$ tee t9 < /tmp
tee: read error: Is a directory
[exit 1]
$ echo x | tee -x
tee: invalid option -- 'x'
Try 'tee --help' for more information.
[exit 1]
$ tee --help | head -2
Usage: tee [OPTION]... [FILE]...
Copy standard input to each FILE, and also to standard output.
