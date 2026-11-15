# clear (ncurses): the bytes for the terminal type, -x, -T, unset and empty TERM, usage errors.
# tags: golden-verified
$ clear | cat -v; echo
^[[H^[[2J^[[3J
$ clear -x | cat -v; echo
^[[H^[[2J
$ clear -T vt100 | cat -v; echo
^[[H^[[J^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@
$ clear -T linux | cat -v; echo
^[[H^[[J^[[3J
$ clear -xT linux | cat -v; echo
^[[H^[[J
$ clear -T tmux-256color | cat -v; echo
^[[H^[[J^[[3J
$ clear -T screen -T xterm | cat -v; echo
^[[H^[[2J^[[3J
$ clear -T dumb; echo $?
1
$ TERM=dumb clear; echo $?
1
$ TERM= clear; echo $?
'': unknown terminal type.
1
$ (unset TERM; clear; echo $?)
TERM environment variable not set.
1
$ clear -V
ncurses 6.4.20240113
$ clear -z; echo $?
clear: invalid option -- 'z'
Usage: clear [options]

Options:
  -T TERM     use this instead of $TERM
  -V          print curses-version
  -x          do not try to clear scrollback
1
$ clear a; echo $?
Usage: clear [options]

Options:
  -T TERM     use this instead of $TERM
  -V          print curses-version
  -x          do not try to clear scrollback
1
$ clear -T; echo $?
clear: option requires an argument -- 'T'
Usage: clear [options]

Options:
  -T TERM     use this instead of $TERM
  -V          print curses-version
  -x          do not try to clear scrollback
1
$ clear -- | cat -v; echo
^[[H^[[2J^[[3J
