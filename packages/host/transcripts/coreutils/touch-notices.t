# touch: date strings, access times and symbolic links' own times are not simulated.
$ touch -d garbage a
[sim] touch: the date string ‘garbage’ is not simulated yet
[sim] supported: 'YYYY-MM-DD [HH:MM[:SS]]', 'YYYY-MM-DDTHH:MM:SS[Z]', '@EPOCH'
[exit 250]
$ touch -d yesterday a
[sim] touch: the date string ‘yesterday’ is not simulated yet
[sim] supported: 'YYYY-MM-DD [HH:MM[:SS]]', 'YYYY-MM-DDTHH:MM:SS[Z]', '@EPOCH'
[exit 250]
$ touch -d 'Nov 10 2026' a
[sim] touch: the date string ‘Nov 10 2026’ is not simulated yet
[sim] supported: 'YYYY-MM-DD [HH:MM[:SS]]', 'YYYY-MM-DDTHH:MM:SS[Z]', '@EPOCH'
[exit 250]
$ touch -a a
[sim] touch: changing only the access time is not simulated yet
[sim] access times are not modeled; -m and the default change the modification time
[exit 250]
$ touch --time=atime a
[sim] touch: changing only the access time is not simulated yet
[sim] access times are not modeled; -m and the default change the modification time
[exit 250]
$ touch -a -m a; echo $?
0
$ ln -s a l; touch -h l
[sim] touch: changing the times of a symbolic link itself (-h) is not simulated yet
[exit 250]
$ touch -h a; echo $?
0
$ touch -
[sim] touch: the operand - (the file on standard output) is not simulated yet
[exit 250]
$ TZ=Europe/Paris touch -d 2026-01-01 a
[sim] touch: local time in the time zone Europe/Paris is not simulated yet
[exit 250]
