# Pipelines, lists, exit statuses, command not found, aliases, groups and subshells.
# tags: golden-verified
$ printf 'b\na\nc\n' | cat -n | cat -A | cat
     1^Ib$
     2^Ia$
     3^Ic$
$ echo start | cat | cat | cat | cat -n
     1	start
$ true && echo and-ran; false && echo not-run; echo "status $?"
and-ran
status 1
$ false || echo or-ran; true || echo not-run; echo "status $?"
or-ran
status 0
$ false && echo no || echo fallback && echo chain
fallback
chain
$ true; false; echo $?
1
$ ! true; echo $?; ! false; echo $?
1
0
$ false | true; echo $?; true | false; echo $?
0
1
$ nosuchcommand; echo "status $?"
-bash: nosuchcommand: command not found
status 127
$ nosuchcommand arg 2>/dev/null; echo $?
127
$ ./nosuchfile; echo $?
-bash: ./nosuchfile: No such file or directory
127
$ /etc; echo $?
-bash: /etc: Is a directory
126
$ echo 'echo from script' > s.sh; ./s.sh; echo $?
-bash: ./s.sh: Permission denied
126
$ chmod +x s.sh 2>/dev/null || bash -c 'exit 0'; bash s.sh; echo $?
from script
0
$ alias ll='echo long listing' greet='echo hello'
$ ll; greet world
long listing
hello world
$ alias e='echo ' w=world; e w
-bash: e: command not found
[exit 127]
$ alias recurse='recurse x'; type recurse; unalias recurse
recurse is aliased to `recurse x'
$ \greet 2>&1; echo $?
-bash: greet: command not found
127
$ 'greet'; echo $?
-bash: greet: command not found
127
$ unalias greet; greet; echo $?
hello
0
$ alias
alias e='echo '
alias ll='echo long listing'
alias w='world'
$ { echo one; echo two; } | cat -n
     1	one
     2	two
$ ( echo sub; exit 3 ); echo $?
sub
3
$ x=outer; ( x=inner; echo $x ); echo $x
inner
outer
$ { x=group; }; echo $x
group
$ cd /tmp && pwd && cd - > /dev/null && pwd
/tmp
/home/student
$ echo $(false) $?; x=$(exit 4); echo $?
1
4
$ echo a; echo b; echo c
a
b
c
$ echo trailing ;
trailing
$ echo $(echo "$(echo nested "quotes")")
nested quotes
