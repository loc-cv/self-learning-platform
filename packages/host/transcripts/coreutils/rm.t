# rm: files, -f, -r, -d, -v, refusals, permission errors. Everything stays inside the home directory.
# tags: golden-verified
$ rm
rm: missing operand
Try 'rm --help' for more information.
[exit 1]
$ rm -f; echo $?
0
% touch a b c; mkdir d e; touch d/x
$ rm nope
rm: cannot remove 'nope': No such file or directory
[exit 1]
$ rm -f nope; echo $?
0
$ rm d
rm: cannot remove 'd': Is a directory
[exit 1]
$ rm -d d
rm: cannot remove 'd': Directory not empty
[exit 1]
$ rm -d e; echo $?
0
$ rm -v a; rm -rv d
removed 'a'
removed 'd/x'
removed directory 'd'
$ mkdir -p q/w/e; touch q/w/e/f; rm -rv q
removed 'q/w/e/f'
removed directory 'q/w/e'
removed directory 'q/w'
removed directory 'q'
$ rm -rf .
rm: refusing to remove '.' or '..' directory: skipping '.'
[exit 1]
$ rm -rf ..
rm: refusing to remove '.' or '..' directory: skipping '..'
[exit 1]
$ rm -r ./
rm: refusing to remove '.' or '..' directory: skipping './'
[exit 1]
$ rm -rf ./.
rm: refusing to remove '.' or '..' directory: skipping './.'
[exit 1]
$ rm -r nod/..
rm: cannot remove 'nod/..': No such file or directory
[exit 1]
# A write-protected file goes without a question when standard input is not a terminal.
$ touch p; chmod 444 p; rm p < /dev/null; echo $?; [ -e p ] || echo gone
0
gone
$ mkdir ro; touch ro/f; chmod 555 ro; rm ro/f
rm: cannot remove 'ro/f': Permission denied
[exit 1]
$ rm -f ro/f
rm: cannot remove 'ro/f': Permission denied
[exit 1]
$ rm -rf ro
rm: cannot remove 'ro/f': Permission denied
[exit 1]
% chmod 755 ro; rm -r ro
$ mkdir np; touch np/f; chmod 000 np; rm -rf np
rm: cannot remove 'np': Permission denied
[exit 1]
$ chmod 700 np; rm -rf np; echo $?
0
$ mkdir nx; touch nx/f; chmod 600 nx; rm -rf nx
rm: cannot remove 'nx/f': Permission denied
[exit 1]
% chmod 700 nx; rm -r nx
$ rm --preserve-root=bad b
rm: unrecognized --preserve-root argument: 'bad'
[exit 1]
$ rm --no-preserve b
rm: you may not abbreviate the --no-preserve-root option
[exit 1]
$ rm -- -foo
rm: cannot remove '-foo': No such file or directory
[exit 1]
$ rm -foo
rm: invalid option -- 'o'
Try 'rm --help' for more information.
[exit 1]
$ touch ./-foo; rm -foo
rm: invalid option -- 'o'
Try 'rm ./-foo' to remove the file '-foo'.
Try 'rm --help' for more information.
[exit 1]
$ rm -- -foo; echo $?
0
$ rm ""
rm: cannot remove '': No such file or directory
[exit 1]
$ touch c; rm c/
rm: cannot remove 'c/': Not a directory
[exit 1]
$ mkdir dd; rm dd/
rm: cannot remove 'dd/': Is a directory
[exit 1]
$ rm -rv dd/
removed directory 'dd/'
$ ln -s c sl; rm sl; [ -e c ] && echo kept
kept
$ mkdir -p t/u; ln -s ../c t/u/l; rm -r t; [ -e c ] && echo kept
kept
$ rm --interactive=never c; echo $?
0
$ rm --interactive=x c
rm: invalid argument ‘x’ for ‘--interactive’
Valid arguments are:
  - ‘never’, ‘no’, ‘none’
  - ‘once’
  - ‘always’, ‘yes’
Try 'rm --help' for more information.
[exit 1]
$ touch c; rm -I c; echo $?
0
