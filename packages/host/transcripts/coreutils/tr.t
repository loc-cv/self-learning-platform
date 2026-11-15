# tr: translation with sets, ranges, classes and repeats; deleting, squeezing, complements,
# truncation, escapes; bytes of multibyte characters; operand and set errors.
# tags: golden-verified
$ echo 'Hello World' | tr a-z A-Z
HELLO WORLD
$ echo 'Hello World' | tr '[:lower:]' '[:upper:]'
HELLO WORLD
$ echo 'Hello World' | tr '[:upper:]' '[:lower:]'
hello world
$ echo 'Hello World 123' | tr '[:lower:][:upper:]' '[:upper:][:lower:]'
hELLO wORLD 123
$ echo 'hello   world' | tr -s ' '
hello world
$ echo hello | tr -d l
heo
$ echo a1b2c3 | tr -d '[:digit:]'
abc
$ echo a1b2c3 | tr -cd '[:digit:]\n'
123
$ echo aabbcc | tr -s a-c
abc
$ echo 'hello World 123' | tr -s l L
heLo WorLd 123
$ echo 'hello World 123' | tr -ds l o
heo Word 123
$ echo abc | tr abc x
xxx
$ echo abc | tr -t abc x
xbc
$ echo aAbB | tr -t '[:upper:]' x
axbB
$ echo abc | tr a-c '[x*]'
xxx
$ echo abcdef | tr a-f '[x*2]yz'
xxyzzz
$ echo 'hello World 123' | tr lo '[x*010]'
hexxx Wxrxd 123
$ echo 'hello World 123' | tr '[:digit:]' '[A*]'
hello World AAA
$ echo 'a b' | tr ' ' '\n'
a
b
$ echo 'a:b' | tr : '\t'
a	b
$ echo abc | tr '\141' Z
Zbc
$ echo 'hello World 123' | tr '\400' x
tr: warning: the ambiguous octal escape \400 is being
	interpreted as the 2-byte sequence \040, 0
helloxWorldx123
$ echo 'hello World 123' | tr '\' x
tr: warning: an unescaped backslash at end of string is not portable
hello World 123
$ echo 'hello World 123' | tr '\q' x
hello World 123
$ echo 'a\b' | tr '\\' /
a/b
$ echo 'a-b' | tr a- xy
xyb
$ echo 'a-b' | tr -- -a yx
xyb
$ echo 'hello World 123' | tr '[:alpha' x
xexxo Worxd 123
$ echo 'hello World 123' | tr a-c-e X
hXllo World 123
$ echo abc | tr '[=a=]' x
xbc
$ echo 'aXb' | tr -c a-z _
a_b_ (no-eol)
$ echo abc | tr -C a _
a___ (no-eol)
$ echo 'hello World 123' | tr -c a xy
yyyyyyyyyyyyyyyy (no-eol)
$ echo 'a b' | tr '[:space:]' _
a_b_ (no-eol)
$ echo 'a  b	c' | tr -s '[:blank:]'
a b	c
$ echo héllo | tr é e
heello
$ echo héllo | tr a-z A-Z
HéLLO
$ echo é | tr -d '\303'
�
$ echo abc | tr '' x
abc
$ echo abc | tr '' ''
abc
$ printf 'one\ntwo\n' | tr '\n' ' '
one two  (no-eol)
$ printf 'hi there\n' > hi; tr a-z A-Z < hi
HI THERE
#
# Errors.
$ tr
tr: missing operand
Try 'tr --help' for more information.
[exit 1]
$ tr a
tr: missing operand after ‘a’
Two strings must be given when translating.
Try 'tr --help' for more information.
[exit 1]
$ tr a b c
tr: extra operand ‘c’
Try 'tr --help' for more information.
[exit 1]
$ tr -d a b
tr: extra operand ‘b’
Only one string may be given when deleting without squeezing repeats.
Try 'tr --help' for more information.
[exit 1]
$ tr -ds a
tr: missing operand after ‘a’
Two strings must be given when both deleting and squeezing repeats.
Try 'tr --help' for more information.
[exit 1]
$ tr -s
tr: missing operand
Try 'tr --help' for more information.
[exit 1]
$ echo abc | tr z-a x
tr: range-endpoints of 'z-a' are in reverse collating sequence order
[exit 1]
$ echo abc | tr '[:foo:]' x
tr: invalid character class ‘foo’
[exit 1]
$ echo abc | tr '[::]' x
tr: missing character class name '[::]'
[exit 1]
$ echo abc | tr '[==]' x
tr: missing equivalence class character '[==]'
[exit 1]
$ echo abc | tr '[=ab=]' x
tr: ab: equivalence class operand must be a single character
[exit 1]
$ echo abc | tr a '[=a=]'
tr: [=c=] expressions may not appear in string2 when translating
[exit 1]
$ echo abc | tr '[:lower:]' '[:digit:]'
tr: when translating, the only character classes that may appear in
string2 are 'upper' and 'lower'
[exit 1]
$ echo abc | tr a-z '[:upper:]'
tr: misaligned [:upper:] and/or [:lower:] construct
[exit 1]
$ echo abc | tr a '[:upper:]'
tr: misaligned [:upper:] and/or [:lower:] construct
[exit 1]
$ echo abc | tr '[x*3]' y
abc
$ echo abc | tr a '[x*y]'
tr: invalid repeat count ‘y’ in [c*n] construct
[exit 1]
$ echo abc | tr a '[x*][y*]'
tr: only one [c*] repeat construct may appear in string2
[exit 1]
$ echo abc | tr -c '[:lower:]' '[:upper:]'
tr: when translating with string1 longer than string2,
the latter string must not end with a character class
[exit 1]
$ echo abc | tr a ''
tr: when not truncating set1, string2 must be non-empty
[exit 1]
$ echo abc | tr -c a '[:upper:]x'
axxK (no-eol)
$ echo abc | tr '[:upper:]' '[:lower:]x'
abc
$ tr a b < /tmp
tr: read error: Is a directory
[exit 1]
$ tr -x
tr: invalid option -- 'x'
Try 'tr --help' for more information.
[exit 1]
$ tr --help | head -2
Usage: tr [OPTION]... STRING1 [STRING2]
Translate, squeeze, and/or delete characters from standard input,
