# grep: invalid regular expressions (glibc's messages), dfa's errors and warnings.
# tags: golden-verified
% printf 'foo\nbar\nFoo bar\nbaz\n' > a; printf 'x\n[\nfoo\n\\(\n' > pf
$ grep -c '[' a
grep: Invalid regular expression
[exit 2]
$ grep -c 'a[' a
grep: Invalid regular expression
[exit 2]
$ grep -c '[^' a
grep: Invalid regular expression
[exit 2]
$ grep -c '[]' a
grep: Unmatched [, [^, [:, [., or [=
[exit 2]
$ grep -c '[^]' a
grep: Unmatched [, [^, [:, [., or [=
[exit 2]
$ grep -c '[]a' a
grep: Unmatched [, [^, [:, [., or [=
[exit 2]
$ grep -c '[[:' a
grep: Unmatched [, [^, [:, [., or [=
[exit 2]
$ grep -c '[[:alpha:' a
grep: Unmatched [, [^, [:, [., or [=
[exit 2]
$ grep -c '[[:alpha:]' a
grep: Unmatched [, [^, [:, [., or [=
[exit 2]
$ grep -c '[[:alpha' a
grep: Unmatched [, [^, [:, [., or [=
[exit 2]
$ grep -c '[[.' a
grep: Unmatched [, [^, [:, [., or [=
[exit 2]
$ grep -c '[[.a' a
grep: Unmatched [, [^, [:, [., or [=
[exit 2]
$ grep -c '[[.a.' a
grep: Unmatched [, [^, [:, [., or [=
[exit 2]
$ grep -c '[[.a.]' a
grep: Unmatched [, [^, [:, [., or [=
[exit 2]
$ grep -c '[[=' a
grep: Unmatched [, [^, [:, [., or [=
[exit 2]
$ grep -c '[[=a=' a
grep: Unmatched [, [^, [:, [., or [=
[exit 2]
$ grep -c '[[=ab=]]' a
grep: Invalid collation character
[exit 2]
$ grep -c '[[.ab.]]' a
grep: Invalid collation character
[exit 2]
$ grep -c '[[.-.]]' a
0
[exit 1]
$ grep -c '[a-[.z.]]' a
4
$ grep -c '[[.a.]-z]' a
4
$ grep -c '[[=a=]-z]' a
grep: Invalid range end
[exit 2]
$ grep -c '[a-z-0]' a
grep: Invalid range end
[exit 2]
$ grep -c '[--z]' a
4
$ grep -c '[%--]' a
0
[exit 1]
$ grep -c '[:alpha:]' a
grep: character class syntax is [[:space:]], not [:space:]
[exit 2]
$ grep -c '[:a]' a
3
$ grep -c '[a:]' a
3
$ grep -c '[::]' a
0
[exit 1]
$ grep -c '[:]' a
0
[exit 1]
$ grep -c '\' a
grep: Trailing backslash
[exit 2]
$ grep -c 'a\' a
grep: Trailing backslash
[exit 2]
$ grep -c '\(' a
grep: Unmatched ( or \(
[exit 2]
$ grep -c '\)' a
grep: Unmatched ) or \)
[exit 2]
$ grep -c 'a\)' a
grep: Unmatched ) or \)
[exit 2]
$ grep -c '\(a' a
grep: Unmatched ( or \(
[exit 2]
$ grep -c '\(\)' a
4
$ grep -c '\{' a
0
[exit 1]
$ grep -c 'a\{' a
grep: Unmatched \{
[exit 2]
$ grep -c 'a\{1' a
grep: Unmatched \{
[exit 2]
$ grep -c 'a\{1,' a
grep: Unmatched \{
[exit 2]
$ grep -c 'a\{1\}' a
3
$ grep -c 'a\{,2\}' a
4
$ grep -c 'a\{\}' a
grep: Invalid content of \{\}
[exit 2]
$ grep -c 'a\{x\}' a
grep: Invalid content of \{\}
[exit 2]
$ grep -c 'a\{1,x\}' a
grep: Invalid content of \{\}
[exit 2]
$ grep -c 'a\{2,1\}' a
grep: Invalid content of \{\}
[exit 2]
$ grep -c 'a\{32767\}' a
0
[exit 1]
$ grep -c 'a\{32768\}' a
grep: Regular expression too big
[exit 2]
$ grep -c 'a*\{2\}' a
4
$ grep -c 'a\{2\}*' a
4
$ grep -c '\(a\)\2' a
grep: Invalid back reference
[exit 2]
$ grep -c '\(a\)\1' a
0
[exit 1]
$ grep -c '\(a\1\)' a
grep: Invalid back reference
[exit 2]
$ grep -c '\1' a
grep: Invalid back reference
[exit 2]
$ grep -c 'a\|*b' a
3
$ grep -c 'a\|\{1\}' a
3
$ grep -c '\(\{1\}\)' a
0
[exit 1]
$ grep -c 'x\+' a
0
[exit 1]
$ grep -c '\+x' a
0
[exit 1]
$ grep -c '\?x' a
0
[exit 1]
$ grep -c '^\+' a
0
[exit 1]
$ grep -c 'a**' a
4
$ grep -c 'a*\+' a
4
# Extended syntax.
$ grep -E -c '(' a
grep: Unmatched ( or \(
[exit 2]
$ grep -E -c ')' a
0
[exit 1]
$ grep -E -c 'a)' a
0
[exit 1]
$ grep -E -c '()' a
4
$ grep -E -c '(|a)' a
4
$ grep -E -c 'a|' a
4
$ grep -E -c '|a' a
4
$ grep -E -c 'a||b' a
4
$ grep -E -c '(a' a
grep: Unmatched ( or \(
[exit 2]
$ grep -E -c '*a' a
grep: warning: * at start of expression
3
$ grep -E -c '+a' a
grep: warning: + at start of expression
3
$ grep -E -c '?a' a
grep: warning: ? at start of expression
3
$ grep -E -c '{1}a' a
grep: warning: {...} at start of expression
3
$ grep -E -c 'a|*b' a
grep: warning: * at start of expression
3
$ grep -E -c '(*a)' a
grep: warning: * at start of expression
3
$ grep -E -c '(+a)' a
grep: warning: + at start of expression
3
$ grep -E -c '^*' a
grep: warning: * at start of expression
4
$ grep -E -c '^+a' a
grep: warning: + at start of expression
0
[exit 1]
$ grep -E -c 'a{' a
0
[exit 1]
$ grep -E -c 'a{1' a
0
[exit 1]
$ grep -E -c 'a{1,' a
0
[exit 1]
$ grep -E -c 'a{,' a
0
[exit 1]
$ grep -E -c 'a{,}' a
4
$ grep -E -c 'a{}' a
grep: Invalid content of \{\}
[exit 2]
$ grep -E -c 'a{x}' a
0
[exit 1]
$ grep -E -c 'a{1,x}' a
0
[exit 1]
$ grep -E -c 'a{1}' a
3
$ grep -E -c 'a{,2}' a
4
$ grep -E -c 'a{2,1}' a
grep: Invalid content of \{\}
[exit 2]
$ grep -E -c 'a{1,2,3}' a
grep: Invalid content of \{\}
[exit 2]
$ grep -E -c 'a{1}{2}' a
0
[exit 1]
$ grep -E -c 'a+*' a
4
$ grep -E -c 'a*?' a
4
$ grep -E -c 'a??' a
4
$ grep -E -c '(a)\2' a
grep: Invalid back reference
[exit 2]
$ grep -E -c '(a)\1' a
0
[exit 1]
$ grep -E -c '\{' a
0
[exit 1]
$ grep -E -c '\}' a
0
[exit 1]
$ grep -E -c '}' a
0
[exit 1]
$ grep -E -c '{' a
0
[exit 1]
$ grep -E -c 'a{1a}' a
0
[exit 1]
$ grep -E -c 'a{32768}' a
grep: Regular expression too big
[exit 2]
$ grep -E -c '^*a' a
grep: warning: * at start of expression
3
$ grep -E -c 'x$y' a
0
[exit 1]
$ grep -E -c '(^a)' a
0
[exit 1]
$ grep -E -c 'a(b$)' a
0
[exit 1]
$ grep -E -c '\' a
grep: Trailing backslash
[exit 2]
$ grep -E -c '[' a
grep: Invalid regular expression
[exit 2]
$ grep -E -c '**a' a
grep: warning: * at start of expression
grep: warning: * at start of expression
3
$ grep -E -c '(+)' a
grep: Unmatched ( or \(
[exit 2]
$ grep -E -c '(+))' a
grep: warning: + at start of expression
0
[exit 1]
$ grep -E -c '{99999}a' a
grep: warning: {...} at start of expression
grep: regular expression too big
[exit 2]
$ grep -E -c '{2,1}a' a
0
[exit 1]
$ grep -E -c 'a^*' a
3
$ grep -E -c '(a)|\1' a
grep: Invalid back reference
[exit 2]
$ grep -c '\(a\)\|b\1' a
grep: Invalid back reference
[exit 2]
$ grep -c '[[=é=]]' a
grep: Invalid collation character
[exit 2]
$ grep -c '[[.space.]]' a
grep: Invalid collation character
[exit 2]
$ grep -c '[^:alpha:]' a
grep: character class syntax is [[:space:]], not [:space:]
[exit 2]
$ grep -c '[[:alpha:]:]' a
4
# Several patterns: every glibc error is printed, then dfa's diagnostics in order.
$ grep -e '[' -e '\(' -e ok a
grep: Invalid regular expression
grep: Unmatched ( or \(
[exit 2]
$ grep -e '[' -e '[' a
grep: Invalid regular expression
[exit 2]
$ grep -f pf a
grep: pf:2: Invalid regular expression
grep: pf:4: Unmatched ( or \(
[exit 2]
$ grep -e '\(a' -f pf a
grep: Unmatched ( or \(
grep: pf:2: Invalid regular expression
grep: pf:4: Unmatched ( or \(
[exit 2]
$ grep -E -e '*a' -e '[:alpha:]' -e '+b' a
grep: warning: * at start of expression
grep: character class syntax is [[:space:]], not [:space:]
[exit 2]
$ grep -e '[:alpha:]' -e '[' a
grep: Invalid regular expression
[exit 2]
$ printf '[\n' | grep -f - a
grep: -:1: Invalid regular expression
[exit 2]
