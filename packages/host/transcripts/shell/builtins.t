# Builtins: cd, pwd, echo, export, unset, alias, unalias, type, history, source, true, false, exit.
# tags: golden-verified
$ history -c
$ pwd; cd /tmp; pwd; echo $PWD $OLDPWD; cd -; cd; pwd
/home/student
/tmp
/tmp /home/student
/home/student
/home/student
$ cd /nonexistent; cd /etc/passwd; cd a b; echo $?
-bash: cd: /nonexistent: No such file or directory
-bash: cd: /etc/passwd: Not a directory
-bash: cd: too many arguments
1
$ cd -z
-bash: cd: -z: invalid option
cd: usage: cd [-L|[-P [-e]] [-@]] [dir]
[exit 2]
$ cd /usr/../etc && pwd; cd
/etc
$ HOME=/tmp cd; pwd; cd
/tmp
$ pwd -P; pwd -z
/home/student
-bash: pwd: -z: invalid option
pwd: usage: pwd [-LP]
[exit 2]
$ echo -n no-newline; echo; echo -e 'tab\there\101'; echo -E 'raw\t'; echo -- -n; echo -nx; echo -e 'cut\chere'; echo
no-newline
tab	here\101
raw\t
-- -n
-nx
cut
$ echo $'\x41\102' "$(echo -e '\xc3\xa9')"
AB é
$ export A=1 B; bash -c 'echo "[$A][$B]"'
[1][]
$ export 1bad=x; echo $?
-bash: export: `1bad=x': not a valid identifier
1
$ export -z
-bash: export: -z: invalid option
export: usage: export [-fn] [name[=value] ...] or export -p
[exit 2]
$ export -n A; bash -c 'echo "[$A]"'
[]
$ C=temp bash -c 'echo "[$C]"'; echo "[$C]"
[temp]
[]
$ X=1; unset X; echo "[$X]"; unset 1bad; echo $?
[]
0
$ unset -z
-bash: unset: -z: invalid option
unset: usage: unset [-f] [-v] [-n] [name ...]
[exit 2]
$ alias l1='echo one' l2="echo 'two'"; alias l1 l2; alias nope; echo $?
alias l1='echo one'
alias l2='echo '\''two'\'''
-bash: alias: nope: not found
1
$ alias -z
-bash: alias: -z: invalid option
alias: usage: alias [-p] [name[=value] ... ]
[exit 2]
$ alias 'bad name=x'
-bash: alias: `bad name': invalid alias name
[exit 1]
$ unalias l1 nope; echo $?; unalias
-bash: unalias: nope: not found
1
unalias: usage: unalias [-a] name [name ...]
[exit 2]
$ type cd echo true type if then
cd is a shell builtin
echo is a shell builtin
true is a shell builtin
type is a shell builtin
if is a shell keyword
then is a shell keyword
$ type cat; cat /dev/null; type cat; type -t cat cd if l2 nothing; echo $?
cat is /usr/bin/cat
cat is hashed (/usr/bin/cat)
file
builtin
keyword
alias
1
$ type -p cat cd; type -P cd cat; echo $?
/usr/bin/cat
/usr/bin/cat
1
$ type -a echo
echo is a shell builtin
echo is /usr/bin/echo
echo is /bin/echo
$ type nothing; echo $?
-bash: type: nothing: not found
1
$ printf 'echo sourced $1 $#\nV=from-file\n' > lib.sh; source lib.sh a b; . ./lib.sh; echo $V
sourced a 2
sourced 0
from-file
$ source; echo $?
-bash: source: filename argument required
source: usage: source filename [arguments]
2
$ source nofile; . /tmp
-bash: nofile: No such file or directory
-bash: .: /tmp: is a directory
[exit 1]
$ true; echo $?; false; echo $?; :; echo $?
0
1
0
$ history
    1  pwd; cd /tmp; pwd; echo $PWD $OLDPWD; cd -; cd; pwd
    2  cd /nonexistent; cd /etc/passwd; cd a b; echo $?
    3  cd -z
    4  cd /usr/../etc && pwd; cd
    5  HOME=/tmp cd; pwd; cd
    6  pwd -P; pwd -z
    7  echo -n no-newline; echo; echo -e 'tab\there\101'; echo -E 'raw\t'; echo -- -n; echo -nx; echo -e 'cut\chere'; echo
    8  echo $'\x41\102' "$(echo -e '\xc3\xa9')"
    9  export A=1 B; bash -c 'echo "[$A][$B]"'
   10  export 1bad=x; echo $?
   11  export -z
   12  export -n A; bash -c 'echo "[$A]"'
   13  C=temp bash -c 'echo "[$C]"'; echo "[$C]"
   14  X=1; unset X; echo "[$X]"; unset 1bad; echo $?
   15  unset -z
   16  alias l1='echo one' l2="echo 'two'"; alias l1 l2; alias nope; echo $?
   17  alias -z
   18  alias 'bad name=x'
   19  unalias l1 nope; echo $?; unalias
   20  type cd echo true type if then
   21  type cat; cat /dev/null; type cat; type -t cat cd if l2 nothing; echo $?
   22  type -p cat cd; type -P cd cat; echo $?
   23  type -a echo
   24  type nothing; echo $?
   25  printf 'echo sourced $1 $#\nV=from-file\n' > lib.sh; source lib.sh a b; . ./lib.sh; echo $V
   26  source; echo $?
   27  source nofile; . /tmp
   28  true; echo $?; false; echo $?; :; echo $?
   29  history
$ history 2
   29  history
   30  history 2
$ history -z
-bash: history: -z: invalid option
history: usage: history [-c] [-d offset] [n] or history -anrw [filename] or history -ps arg [arg...]
[exit 2]
$ exit 1 2; echo $?
logout
-bash: exit: too many arguments
[exit 2]
$ exit 7
logout
[exit 7]
