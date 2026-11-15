# head: options the simulator does not support print the [sim] notice.
% echo a > a
$ head -z a
[sim] head: the flag -z is not simulated yet
[exit 250]
$ head --zero-terminated a
[sim] head: the flag --zero-terminated is not simulated yet
[exit 250]
$ head -1z a
[sim] head: the flag -z is not simulated yet
[exit 250]
$ head --version
[sim] head: the flag --version is not simulated yet
[exit 250]
