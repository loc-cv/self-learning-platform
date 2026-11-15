# The coreutils pwd binary: physical by default, -L with a usable $PWD, ignored operands, errors.
# tags: golden-verified
% mkdir -p real/sub; ln -s real lnk; cd lnk/sub
$ env pwd
/home/student/real/sub
$ env pwd -L
/home/student/lnk/sub
$ env pwd -P
/home/student/real/sub
$ env pwd -LP
/home/student/real/sub
$ env pwd -PL
/home/student/lnk/sub
$ PWD=/tmp/../tmp env pwd -L
/home/student/real/sub
$ PWD=relative env pwd -L
/home/student/real/sub
$ PWD=/ env pwd -L
/home/student/real/sub
$ env pwd extra
pwd: ignoring non-option arguments
/home/student/real/sub
$ env pwd -x
pwd: invalid option -- 'x'
Try 'pwd --help' for more information.
[exit 1]
$ env pwd --logical --phys
/home/student/real/sub
$ POSIXLY_CORRECT=1 env pwd
/home/student/lnk/sub
$ cd /; env pwd; /bin/pwd -L
/
/
