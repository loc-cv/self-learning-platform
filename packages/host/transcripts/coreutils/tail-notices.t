# tail: options the simulator does not support print the [sim] notice.
% echo a > a
$ tail --pid=1 -f a
[sim] tail: the flag --pid is not simulated yet
[exit 250]
$ tail -s 2 -f a
[sim] tail: the flag -s is not simulated yet
[exit 250]
$ tail --retry a
[sim] tail: the flag --retry is not simulated yet
[exit 250]
$ tail --max-unchanged-stats=3 a
[sim] tail: the flag --max-unchanged-stats is not simulated yet
[exit 250]
$ tail -z a
[sim] tail: the flag -z is not simulated yet
[exit 250]
$ tail -f
[sim] tail: following a terminal on standard input is not simulated yet
[exit 250]
$ tail --version
[sim] tail: the flag --version is not simulated yet
[exit 250]
