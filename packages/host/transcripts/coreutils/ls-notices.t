# ls options and settings the simulator does not model print the [sim] notice: access and birth
# times (the VFS keeps neither), --dired, --zero, hyperlinks, --version, local time in a zone
# other than UTC, and time format conversions not implemented.
% touch f
$ ls -u
[sim] ls: the flag -u is not simulated yet
[exit 250]
$ ls -lu
[sim] ls: the flag -u is not simulated yet
[exit 250]
$ ls -l --time=atime
[sim] ls: the access time (--time=atime) is not simulated yet
[exit 250]
$ ls -t --time=birth
[sim] ls: the birth time (--time=birth) is not simulated yet
[exit 250]
$ ls -D
[sim] ls: the flag -D is not simulated yet
[exit 250]
$ ls --dired
[sim] ls: the flag --dired is not simulated yet
[exit 250]
$ ls --zero
[sim] ls: the flag --zero is not simulated yet
[exit 250]
$ ls --hyperlink f
[sim] ls: the flag --hyperlink is not simulated yet
[exit 250]
$ ls --hyperlink=never f
f
$ ls --hyperlink=auto f | cat
f
$ ls --version
[sim] ls: the flag --version is not simulated yet
[exit 250]
$ TZ=Europe/Paris ls -l f
[sim] ls: local time in the time zone Europe/Paris is not simulated yet
[exit 250]
$ TZ=Europe/Paris ls f
f
$ TZ=UTC ls -l --time-style=+%Y f
-rw-r--r-- 1 student student 0 2026 f
$ ls -l --time-style=+%V f
[sim] ls: the time format conversion %V is not simulated yet
[exit 250]
