# Shell syntax and builtins outside the simulated subset print a [sim] notice and run nothing.
# Not golden-verified: the real bash runs these. docs/FIDELITY.md §4.
$ for x in a b; do echo $x; done
[sim] bash: the "for" loop is not simulated yet
[exit 250]
$ echo before; if true; then echo yes; fi
[sim] bash: the "if" statement is not simulated yet
[exit 250]
$ while false; do :; done
[sim] bash: the "while" loop is not simulated yet
[exit 250]
$ until true; do :; done
[sim] bash: the "until" loop is not simulated yet
[exit 250]
$ case x in x) echo x;; esac
[sim] bash: the "case" statement is not simulated yet
[exit 250]
$ f() { echo hi; }
[sim] bash: defining a function is not simulated yet
[exit 250]
$ function g { echo hi; }
[sim] bash: defining a function is not simulated yet
[exit 250]
$ [[ -n x ]]
[sim] bash: the "[[" conditional command is not simulated yet
[exit 250]
$ (( 1 + 1 ))
[sim] bash: arithmetic evaluation "(( ))" is not simulated yet
[exit 250]
$ echo $((1 + 1))
[sim] bash: arithmetic expansion "$(( ))" is not simulated yet
[exit 250]
$ sleep 1 &
[sim] bash: the "&" operator (background jobs) is not simulated yet
[exit 250]
$ cat <(echo x)
[sim] bash: process substitution is not simulated yet
[exit 250]
$ echo hello!world
[sim] bash: history expansion with "!" is not simulated yet
[exit 250]
$ echo 'quoted!fine' "end!"
quoted!fine end!
$ x=abc; echo ${x%c}
[sim] bash: the parameter expansion "${x%c}" is not simulated yet
[exit 250]
$ arr=(a b)
[sim] bash: array assignment is not simulated yet
[exit 250]
$ time echo
[sim] bash: the "time" keyword is not simulated yet
[exit 250]
$ read line
[sim] bash: the builtin "read" is not simulated yet
[exit 250]
$ set -e; echo $?
[sim] bash: the builtin "set" is not simulated yet
250
$ bash -x -c 'echo'
[sim] bash: the option -x is not simulated yet
[exit 250]
$ mawk 1
[sim] mawk: this program is not simulated yet
[exit 250]
$ awk 1
[sim] awk: this program is not simulated yet
[exit 250]
