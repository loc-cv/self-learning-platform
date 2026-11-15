# ls behavior that depends on the file system and is modeled, not captured: "directory order"
# (-U, -f) is the simulated file system's order, name order; . and .. come first.
% mkdir u && cd u && touch b c a && mkdir d
$ ls -U
a  b  c  d
$ ls -f
.  ..  a  b  c	d
$ ls -U -r -1
a
b
c
d
$ ls -fS
.  ..  d  a  b	c
