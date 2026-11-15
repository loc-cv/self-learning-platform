# The coreutils true and false binaries: exit status, --help only as the sole argument.
# tags: golden-verified
$ env true; echo $?
0
$ env false; echo $?
1
$ /bin/true -x --bogus; echo $?
0
$ /bin/false --help x; echo $?
1
$ env true --he; echo $?
0
$ /usr/bin/false --help | head -3
Usage: /usr/bin/false [ignored command line arguments]
  or:  /usr/bin/false OPTION
Exit with a status code indicating failure.
$ /usr/bin/false --help > /dev/null; echo $?
1
$ env true --help | head -4
Usage: true [ignored command line arguments]
  or:  true OPTION
Exit with a status code indicating success.

