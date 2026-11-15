# grep: real options and inputs the simulator does not support print the [sim] notice.
% printf 'foo\n' > a
$ grep -P 'fo+' a
[sim] grep: the flag -P is not simulated yet
[exit 250]
$ grep -oP 'f\Ko+' a
[sim] grep: the flag -P is not simulated yet
[exit 250]
$ grep --perl-regexp 'fo+' a
[sim] grep: the flag --perl-regexp is not simulated yet
[exit 250]
$ grep -T -n foo a
[sim] grep: the flag -T is not simulated yet
[exit 250]
$ grep -X egrep foo a
[sim] grep: the flag -X is not simulated yet
[exit 250]
$ grep -V
[sim] grep: the flag -V is not simulated yet
[exit 250]
$ grep --version
[sim] grep: the flag --version is not simulated yet
[exit 250]
# Executable stubs have no content to search.
$ grep foo /usr/bin/ls
[sim] grep: binary content of an executable stub for ls is not simulated yet
[exit 250]
$ grep -r foo /usr/bin
[sim] grep: binary content of an executable stub for [ is not simulated yet
[exit 250]
