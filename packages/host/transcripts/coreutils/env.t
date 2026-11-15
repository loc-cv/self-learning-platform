# env: printing and modifying the environment, running a command through PATH, errors.
# tags: golden-verified
$ env -i
$ env -i A=1 B=2 A=3
A=3
B=2
$ env - A=1 env
A=1
$ env -i A=1 B=2 env -u A
B=2
$ env -i A=1 B=2 -u A env
env: ‘-u’: No such file or directory
[exit 127]
$ env -i A=1 -i env
env: ‘-i’: No such file or directory
[exit 127]
$ env -i "A B=1" =x A= env
A B=1
=x
A=
$ env -0 -i A=1 B=2 | cat -v; echo
A=1^@B=2^@
$ env -i FOO=bar bash -c 'echo $FOO'
bar
$ env -i echo default PATH
default PATH
$ env -i PATH=/nope echo hi; echo $?
env: ‘echo’: No such file or directory
127
$ env -i PATH=:/nope:/usr/bin echo found
found
$ env nope; echo $?
env: ‘nope’: No such file or directory
127
$ env /etc/passwd; echo $?
env: ‘/etc/passwd’: Permission denied
126
$ env /etc; echo $?
env: ‘/etc’: Permission denied
126
$ env ./nope; echo $?
env: ‘./nope’: No such file or directory
127
$ env -u A=b true; echo $?
env: cannot unset ‘A=b’: Invalid argument
125
$ env -u '' true; echo $?
env: cannot unset ‘’: Invalid argument
125
$ env -u
env: option requires an argument -- 'u'
Try 'env --help' for more information.
[exit 125]
$ env -x
env: invalid option -- 'x'
Try 'env --help' for more information.
[exit 125]
$ env --chdir
env: option '--chdir' requires an argument
Try 'env --help' for more information.
[exit 125]
$ env -C / pwd
/
$ env -C /nope pwd; echo $?
env: cannot change directory to '/nope': No such file or directory
125
$ env -C /etc/passwd true; echo $?
env: cannot change directory to '/etc/passwd': Not a directory
125
$ env -C /; echo $?
env: must specify command with --chdir (-C)
Try 'env --help' for more information.
125
$ env -0 -i true; echo $?
env: cannot specify --null (-0) with command
Try 'env --help' for more information.
125
$ env -i -C / -- pwd
/
$ env --help | head -3
Usage: env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]
Set each NAME to VALUE in the environment and run COMMAND.

