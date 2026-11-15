# Redirections: >, >>, <, 2>, 2>&1 and its ordering, &>, &>>, >&N, N<&-, here-strings,
# here-documents (also into pipelines), and the errors the shell reports.
# tags: golden-verified
$ echo one > f; echo two >> f; cat f
one
two
$ cat < f
one
two
$ cat f nope > out 2> err; cat out; echo ---; cat err
one
two
---
cat: nope: No such file or directory
#
# 2>&1 duplicates descriptor 1 as it is at that point: the order of the two redirections matters.
$ cat f nope > both 2>&1; cat both
one
two
cat: nope: No such file or directory
$ cat f nope 2>&1 > only-out; echo ---; cat only-out
cat: nope: No such file or directory
---
one
two
$ cat f nope &> amp; cat amp
one
two
cat: nope: No such file or directory
$ cat nope &>> amp; cat amp
one
two
cat: nope: No such file or directory
cat: nope: No such file or directory
$ echo to-stderr >&2
to-stderr
$ echo to-stderr 1>&2 2>/dev/null
to-stderr
$ { echo a; echo b >&2; } 2>&1 | cat -n
     1	a
     2	b
$ cat <<< "here string $HOME"
here string /home/student
$ cat <<EOF
> plain $HOME
> \$escaped `echo cmd` $(echo sub)
> EOF
plain /home/student
$escaped cmd sub
$ cat <<'EOF'
> quoted $HOME `echo no`
> EOF
quoted $HOME `echo no`
$ cat <<-EOF | cat -n
> 	tabs stripped
> 		both
> 	EOF
     1	tabs stripped
     2	both
$ cat <<A <<B
> first
> A
> second
> B
second
$ echo x > /nonexistent/f
-bash: /nonexistent/f: No such file or directory
[exit 1]
$ cat < missing
-bash: missing: No such file or directory
[exit 1]
$ echo x > /etc/passwd
-bash: /etc/passwd: Permission denied
[exit 1]
$ echo x 3>&1 1>&2 2>&3 | cat
x
$ cat <&5
-bash: 5: Bad file descriptor
[exit 1]
$ echo closed >&-
-bash: echo: write error: Bad file descriptor
[exit 1]
$ x="a b"; echo > $x
-bash: $x: ambiguous redirect
[exit 1]
$ echo -n > empty; cat empty; echo "[$?]"
[0]
$ > created; cat created
$ echo grouped > g1 > g2; cat g1; echo ---; cat g2
---
grouped
