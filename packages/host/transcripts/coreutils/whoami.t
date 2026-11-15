# whoami: the effective user's name, usage errors.
# tags: golden-verified
$ whoami
student
$ whoami x
whoami: extra operand ‘x’
Try 'whoami --help' for more information.
[exit 1]
$ whoami -x
whoami: invalid option -- 'x'
Try 'whoami --help' for more information.
[exit 1]
$ whoami --help | head -3
Usage: whoami [OPTION]...
Print the user name associated with the current effective user ID.
Same as id -un.
