# uniq: options the simulator does not support print the [sim] notice.
% echo a > a
$ uniq -z a
[sim] uniq: the flag -z is not simulated yet
[exit 250]
$ uniq -1 a
[sim] uniq: the flag -1 is not simulated yet
[exit 250]
$ uniq --version
[sim] uniq: the flag --version is not simulated yet
[exit 250]
