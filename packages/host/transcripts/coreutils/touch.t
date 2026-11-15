# touch: create, -c, -d, -t, -r, -m, errors. Times are compared with test's -nt and -ot.
# tags: golden-verified
$ touch
touch: missing file operand
Try 'touch --help' for more information.
[exit 1]
$ touch a b; [ -f a ] && [ -f b ] && echo created
created
$ printf 'keep\n' > k; touch k; cat k
keep
$ touch -d '2026-11-10 08:30:00' a; touch -d '2026-11-10T08:30:01Z' b; [ b -nt a ] && echo newer
newer
$ touch -t 202611100830 c; [ c -nt a ] || [ a -nt c ] || echo same
same
$ touch -d @1794299400 c; [ c -nt a ] || [ a -nt c ] || echo same
same
$ touch -r b c; [ c -nt b ] || [ b -nt c ] || echo same
same
$ touch -m -d 2026-01-01 c; [ c -ot a ] && echo older
older
$ touch -c nope; echo $?; [ -e nope ] || echo absent
0
absent
$ touch -d 2026-13-10 a
touch: invalid date format ‘2026-13-10’
[exit 1]
$ touch -d '2026-11-10 25:00' a
touch: invalid date format ‘2026-11-10 25:00’
[exit 1]
$ touch -t 1110083 a
touch: invalid date format ‘1110083’
[exit 1]
$ touch -t 202613100830 a
touch: invalid date format ‘202613100830’
[exit 1]
$ touch -t 202611100830.61 a
touch: invalid date format ‘202611100830.61’
[exit 1]
$ touch -d 2026-11-10 -t 202601010000 a
touch: cannot specify times from more than one source
Try 'touch --help' for more information.
[exit 1]
$ touch -r nope a
touch: failed to get attributes of 'nope': No such file or directory
[exit 1]
$ touch nod/x
touch: cannot touch 'nod/x': No such file or directory
[exit 1]
$ touch /etc/passwd
touch: cannot touch '/etc/passwd': Permission denied
[exit 1]
$ touch -c /etc/passwd
touch: setting times of '/etc/passwd': Permission denied
[exit 1]
$ touch -d 2026-01-01 /etc/passwd
touch: cannot touch '/etc/passwd': Permission denied
[exit 1]
% mkdir ro d; chmod 555 ro
$ touch ro/x
touch: cannot touch 'ro/x': Permission denied
[exit 1]
$ touch d; echo $?
0
$ touch a/
touch: setting times of 'a/': Not a directory
[exit 1]
$ touch d/
$ touch e/
touch: setting times of 'e/': No such file or directory
[exit 1]
$ touch -h -d 2026-01-01 nope
touch: setting times of 'nope': No such file or directory
[exit 1]
$ touch --time=x a
touch: invalid argument ‘x’ for ‘--time’
Valid arguments are:
  - ‘atime’, ‘access’, ‘use’
  - ‘mtime’, ‘modify’
Try 'touch --help' for more information.
[exit 1]
$ touch --time=m -d 2026-01-01 b; [ b -ot a ] && echo older
older
$ touch -f a; echo $?
0
$ touch -z a
touch: invalid option -- 'z'
Try 'touch --help' for more information.
[exit 1]
# A read-only file of one's own still gets new times; someone else's needs write permission.
% chmod 444 a
$ touch a; echo $?
0
$ touch /etc/hostname
touch: cannot touch '/etc/hostname': Permission denied
[exit 1]
