# Syntax errors and the shell's own diagnostics, interactive and with bash -c and scripts.
# tags: golden-verified
$ echo )
-bash: syntax error near unexpected token `)'
[exit 2]
$ ls | | cat
-bash: syntax error near unexpected token `|'
[exit 2]
$ echo a;;
-bash: syntax error near unexpected token `;;'
[exit 2]
$ echo ; ;
-bash: syntax error near unexpected token `;'
[exit 2]
$ ( )
-bash: syntax error near unexpected token `)'
[exit 2]
$ { }
-bash: syntax error near unexpected token `}'
[exit 2]
$ fi
-bash: syntax error near unexpected token `fi'
[exit 2]
$ done
-bash: syntax error near unexpected token `done'
[exit 2]
$ then echo x
-bash: syntax error near unexpected token `then'
[exit 2]
$ echo >
-bash: syntax error near unexpected token `newline'
[exit 2]
$ echo a > > b
-bash: syntax error near unexpected token `>'
[exit 2]
$ | cat
-bash: syntax error near unexpected token `|'
[exit 2]
$ && echo
-bash: syntax error near unexpected token `&&'
[exit 2]
$ echo a & & echo
-bash: syntax error near unexpected token `&'
[exit 2]
$ bash -c 'echo )'
bash: -c: line 1: syntax error near unexpected token `)'
bash: -c: line 1: `echo )'
[exit 2]
$ bash -c 'echo "unterminated'
bash: -c: line 1: unexpected EOF while looking for matching `"'
[exit 2]
$ bash -c "echo 'single"
bash: -c: line 1: unexpected EOF while looking for matching `''
[exit 2]
$ bash -c 'echo ok; foo; echo after'
ok
bash: line 1: foo: command not found
after
$ bash -c 'cat <<EOF
> body'
bash: line 2: warning: here-document at line 1 delimited by end-of-file (wanted `EOF')
body
$ bash -c 'echo $0 $1 $#' zero one two
zero one 2
$ bash -c
bash: -c: option requires an argument
[exit 2]
$ bash -Q
bash: -Q: invalid option
Usage:	bash [GNU long option] [option] ...
	bash [GNU long option] [option] script-file ...
GNU long options:
	--debug
	--debugger
	--dump-po-strings
	--dump-strings
	--help
	--init-file
	--login
	--noediting
	--noprofile
	--norc
	--posix
	--pretty-print
	--rcfile
	--restricted
	--verbose
	--version
Shell options:
	-ilrsD or -c command or -O shopt_option		(invocation only)
	-abefhkmnptuvxBCEHPT or -o option
[exit 2]
$ printf 'echo one\nnope\necho )\necho never\n' > t.sh; bash t.sh; echo "status $?"
one
t.sh: line 2: nope: command not found
t.sh: line 3: syntax error near unexpected token `)'
t.sh: line 3: `echo )'
status 2
$ bash missing.sh
bash: missing.sh: No such file or directory
[exit 127]
$ bash /tmp
/tmp: /tmp: Is a directory
[exit 126]
$ echo 'echo $0 $1' | bash -s arg
bash arg
$ echo ${x:?custom message}; echo not-reached
-bash: x: custom message
[exit 1]
$ echo ${unset_var?}
-bash: unset_var: parameter not set
[exit 1]
$ bash -c 'echo ${x:?gone}; echo after'; echo "status $?"
bash: line 1: x: gone
status 127
$ echo ${}
-bash: ${}: bad substitution
[exit 1]
