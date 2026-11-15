# cat: files, standard input, numbering, visible ends and tabs, squeezing, errors.
# tags: golden-verified
% printf 'one\n\ttwo\n\n\n\nthree' > a; printf 'x\n' > b
$ cat a b
one
	two



threex
$ cat b - b <<< middle
x
middle
x
$ cat -n a
     1	one
     2		two
     3	
     4	
     5	
     6	three (no-eol)
$ cat -b a
     1	one
     2		two



     3	three (no-eol)
$ cat -A a
one$
^Itwo$
$
$
$
three (no-eol)
$ cat -s -E a
one$
	two$
$
three (no-eol)
$ cat -T b a
x
one
^Itwo



three (no-eol)
$ printf 'caf\xc3\xa9 \x01\x7f\n' | cat -v
cafM-CM-) ^A^?
$ cat nope b /tmp "a b"
cat: nope: No such file or directory
x
cat: /tmp: Is a directory
cat: 'a b': No such file or directory
[exit 1]
$ cat -z
cat: invalid option -- 'z'
Try 'cat --help' for more information.
[exit 1]
$ cat --nu b
cat: option '--nu' is ambiguous; possibilities: '--number-nonblank' '--number'
Try 'cat --help' for more information.
[exit 1]
$ echo piped | cat | cat -n
     1	piped
$ cat < a > c; cat c
one
	two



three (no-eol)
$ cat --help | head -3
Usage: cat [OPTION]... [FILE]...
Concatenate FILE(s) to standard output.

