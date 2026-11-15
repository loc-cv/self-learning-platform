# Options and forms of the misc group that are real but not simulated: each prints the notice and
# exits 250 (docs/FIDELITY.md §4). Not golden: the real tools behave differently here.
$ sleep --version
[sim] sleep: the flag --version is not simulated yet
[exit 250]
$ env -S 'echo hi'
[sim] env: the flag -S is not simulated yet
[exit 250]
$ env --default-signal true
[sim] env: the flag --default-signal is not simulated yet
[exit 250]
$ env -v true
[sim] env: the flag -v is not simulated yet
[exit 250]
$ date --debug -d @0
[sim] date: the flag --debug is not simulated yet
[exit 250]
$ date --resolution
[sim] date: the flag --resolution is not simulated yet
[exit 250]
$ TZ=America/New_York date -d @0
[sim] date: the time zone TZ=America/New_York is not simulated yet
[sim] the simulated machines run in UTC; TZ=UTC or an unset TZ works
[exit 250]
$ date -d 'next friday'
[sim] date: the date string ‘next friday’ is not simulated yet
[sim] date -d understands @SECONDS, YYYY-MM-DD [HH:MM[:SS]], ISO 8601 with T and Z or an offset, now, today, tomorrow, yesterday and items like "2 days ago"
[exit 250]
$ date -d @0 '+%5T'
[sim] date: the date format %5T is not simulated yet
[exit 250]
$ seq -f %a 1
[sim] seq: the %a format is not simulated yet
[exit 250]
$ env printf '%a\n' 1
[sim] printf: the printf conversion %a is not simulated yet
[exit 250]
$ env test -N /etc/passwd
[sim] test: the test operator -N is not simulated yet
[exit 250]
$ id -Z root
[sim] id: the flag -Z with a user is not simulated yet
[exit 250]
$ /bin/echo --version
[sim] echo: the flag --version is not simulated yet
[exit 250]
