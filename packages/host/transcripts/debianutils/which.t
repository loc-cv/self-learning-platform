# which (debianutils): PATH search, -a, names with a slash, status, getopts errors.
# tags: golden-verified
% printf '#!/bin/sh\n' > tool; chmod +x tool; printf 'data\n' > plain
$ which ls
/usr/bin/ls
$ which ls cat; echo $?
/usr/bin/ls
/usr/bin/cat
0
$ which ls nope cat; echo $?
/usr/bin/ls
/usr/bin/cat
1
$ which nope; echo $?
1
$ which; echo $?
1
$ which -a sh
/usr/bin/sh
/bin/sh
$ PATH=/bin:/usr/bin:/bin which -a ls
/bin/ls
/usr/bin/ls
/bin/ls
$ which -s ls; echo $?
0
$ which -s nope; echo $?
1
$ which -as ls; echo $?
0
$ which /bin/ls ./tool ./plain /etc; echo $?
/bin/ls
./tool
1
$ which tool; echo $?
1
$ PATH=/usr/bin: which tool
./tool
$ PATH=:/usr/bin which tool
./tool
$ PATH=/usr/bin::/bin which tool
./tool
$ PATH= /usr/bin/which ls; echo $?
1
$ which ''; echo $?
1
$ which -- ls
/usr/bin/ls
$ which -x ls; echo $?
Illegal option -x
Usage: /usr/bin/which [-as] args
2
$ which -sx ls; echo $?
Illegal option -x
2
$ which --help; echo $?
Illegal option --
Usage: /usr/bin/which [-as] args
2
$ /usr/bin/which -q
Illegal option -q
Usage: /usr/bin/which [-as] args
[exit 2]
