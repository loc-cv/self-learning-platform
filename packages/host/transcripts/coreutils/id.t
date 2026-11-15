# id: the forms that do not depend on the workstation's own groups (the full default line and -G
# of the current user are covered in id.test.ts): named users, single IDs, names, errors.
# tags: golden-verified
$ id root
uid=0(root) gid=0(root) groups=0(root)
$ id daemon
uid=1(daemon) gid=1(daemon) groups=1(daemon)
$ id nobody
uid=65534(nobody) gid=65534(nogroup) groups=65534(nogroup)
$ id -u; id -g; id -un; id -gn; id -ur; id -nu
1000
1000
student
student
1000
student
$ id -u root; id -gn root; id -G root; id -Gn daemon
0
root
0
daemon
$ id 0; id +1
uid=0(root) gid=0(root) groups=0(root)
uid=1(daemon) gid=1(daemon) groups=1(daemon)
$ id -u root daemon
0
1
$ id -uz root | cat -v; echo
0^@
$ id -Gz root | cat -v; echo
0^@
$ id nope; echo $?
id: ‘nope’: no such user
1
$ id root nope daemon; echo $?
uid=0(root) gid=0(root) groups=0(root)
id: ‘nope’: no such user
uid=1(daemon) gid=1(daemon) groups=1(daemon)
1
$ id -n
id: cannot print only names or real IDs in default format
[exit 1]
$ id -r
id: cannot print only names or real IDs in default format
[exit 1]
$ id -ug
id: cannot print "only" of more than one choice
[exit 1]
$ id -z
id: option --zero not permitted in default format
[exit 1]
$ id -a root
uid=0(root) gid=0(root) groups=0(root)
$ id -Z
id: --context (-Z) works only on an SELinux-enabled kernel
[exit 1]
$ id -x
id: invalid option -- 'x'
Try 'id --help' for more information.
[exit 1]
$ id --help | head -3
Usage: id [OPTION]... [USER]...
Print user and group information for each specified USER,
or (when USER omitted) for the current process.
