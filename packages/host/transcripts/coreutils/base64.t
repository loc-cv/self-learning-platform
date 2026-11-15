# base64: encoding with and without wrapping, decoding, garbage, invalid input, errors.
# tags: golden-verified
% printf 'foo\nbar\nFoo bar\nbaz\n' > a; mkdir d; printf 'aGVsbG8=\n' > enc
$ printf 'hello' | base64
aGVsbG8=
$ printf '' | base64; echo $?
0
$ base64 a
Zm9vCmJhcgpGb28gYmFyCmJhego=
$ base64 - < a
Zm9vCmJhcgpGb28gYmFyCmJhego=
$ seq 1 40 | base64
MQoyCjMKNAo1CjYKNwo4CjkKMTAKMTEKMTIKMTMKMTQKMTUKMTYKMTcKMTgKMTkKMjAKMjEKMjIK
MjMKMjQKMjUKMjYKMjcKMjgKMjkKMzAKMzEKMzIKMzMKMzQKMzUKMzYKMzcKMzgKMzkKNDAK
$ seq 1 40 | base64 -w 20
MQoyCjMKNAo1CjYKNwo4
CjkKMTAKMTEKMTIKMTMK
MTQKMTUKMTYKMTcKMTgK
MTkKMjAKMjEKMjIKMjMK
MjQKMjUKMjYKMjcKMjgK
MjkKMzAKMzEKMzIKMzMK
MzQKMzUKMzYKMzcKMzgK
MzkKNDAK
$ seq 1 10 | base64 -w0; echo
MQoyCjMKNAo1CjYKNwo4CjkKMTAK
$ seq 1 10 | base64 --wrap=0 | wc -c
28
$ printf 'abcdefgh' | base64 -w 3
YWJ
jZG
VmZ
2g=
$ printf 'é ü 中\n' | base64
w6kgw7wg5LitCg==
$ base64 -d enc
hello (no-eol)
$ printf 'aGVsbG8=' | base64 -d; echo
hello
$ printf 'aGVs\nbG8=\n' | base64 -d; echo
hello
$ printf 'aGVsbG8=aGk=' | base64 -d; echo
hellohi
$ printf 'Zm9v\n\n' | base64 -d
foo (no-eol)
$ printf 'w6kg/CDkuK0K' | base64 -d
é � 中
$ base64 a | base64 -d
foo
bar
Foo bar
baz
$ seq 1 2000 | base64 | base64 -d | tail -1
2000
$ printf 'aGV sbG8=' | base64 -di; echo
hello
$ printf 'a*G!V\tsbG8=' | base64 --ignore-garbage -d; echo
hello
# Invalid input: what could be decoded is written before the error.
$ printf 'aGVsbG8' | base64 -d; echo; echo $?
hellobase64: invalid input

0
$ printf 'aGV sbG8=' | base64 -d; echo
hebase64: invalid input

$ printf 'aGVsbG8===' | base64 -d; echo
hellobase64: invalid input

$ printf '=' | base64 -d
base64: invalid input
[exit 1]
$ printf 'Zg' | base64 -d; echo
fbase64: invalid input

$ printf 'Z' | base64 -d
base64: invalid input
[exit 1]
$ printf 'aGVs\r\nbG8=\r\n' | base64 -d; echo
helbase64: invalid input

# Errors.
$ base64 nope
base64: nope: No such file or directory
[exit 1]
$ base64 a b
base64: extra operand ‘b’
Try 'base64 --help' for more information.
[exit 1]
$ base64 -w x a
base64: invalid wrap size: ‘x’
[exit 1]
$ base64 -w -1 a
base64: invalid wrap size: ‘-1’
[exit 1]
$ base64 -w '' a
base64: invalid wrap size: ‘’
[exit 1]
$ base64 -d d
base64: read error: Is a directory
[exit 1]
$ base64 d
base64: read error: Is a directory
[exit 1]
$ base64 -z a
base64: invalid option -- 'z'
Try 'base64 --help' for more information.
[exit 1]
$ base64 --de enc
hello (no-eol)
$ base64 --help | head -3
Usage: base64 [OPTION]... [FILE]
Base64 encode or decode FILE, or standard input, to standard output.

