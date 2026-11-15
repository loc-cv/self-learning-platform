# rmdir: empty directories, -p, -v, --ignore-fail-on-non-empty, errors.
# tags: golden-verified
$ rmdir
rmdir: missing operand
Try 'rmdir --help' for more information.
[exit 1]
% mkdir -p a/b/c e full; touch full/x f
$ rmdir -v e; [ -d e ] || echo gone
rmdir: removing directory, 'e'
gone
$ rmdir full
rmdir: failed to remove 'full': Directory not empty
[exit 1]
$ rmdir --ignore-fail-on-non-empty full; echo $?
0
$ rmdir f
rmdir: failed to remove 'f': Not a directory
[exit 1]
$ rmdir nope
rmdir: failed to remove 'nope': No such file or directory
[exit 1]
$ rmdir a
rmdir: failed to remove 'a': Directory not empty
[exit 1]
$ rmdir -pv a/b/c; [ -d a ] || echo gone
rmdir: removing directory, 'a/b/c'
rmdir: removing directory, 'a/b'
rmdir: removing directory, 'a'
gone
% mkdir -p p/q/r; touch p/keep
$ rmdir -p p/q/r
rmdir: failed to remove directory 'p': Directory not empty
[exit 1]
$ rmdir -p --ignore-fail-on-non-empty p/q; echo $?
rmdir: failed to remove 'p/q': No such file or directory
1
$ rmdir -vp p/
rmdir: removing directory, 'p/'
rmdir: failed to remove 'p/': Directory not empty
[exit 1]
% mkdir -p s/t; ln -s s/t lt
$ rmdir lt/
rmdir: failed to remove 'lt/': Symbolic link not followed
[exit 1]
$ rmdir lt
rmdir: failed to remove 'lt': Not a directory
[exit 1]
$ rmdir .
rmdir: failed to remove '.': Invalid argument
[exit 1]
$ rmdir ..
rmdir: failed to remove '..': Directory not empty
[exit 1]
$ rmdir s/t/..
rmdir: failed to remove 's/t/..': Directory not empty
[exit 1]
% mkdir -p ro/sub; chmod 555 ro
$ rmdir ro/sub
rmdir: failed to remove 'ro/sub': Permission denied
[exit 1]
$ rmdir --ignore-fail-on-non-empty ro/sub
rmdir: failed to remove 'ro/sub': Permission denied
[exit 1]
$ rmdir --ignore-fail-on-non-empty ro
% chmod 755 ro
$ mkdir -p u/v//; rmdir -pv u//v//
rmdir: removing directory, 'u//v//'
rmdir: removing directory, 'u'
$ rmdir -x
rmdir: invalid option -- 'x'
Try 'rmdir --help' for more information.
[exit 1]
