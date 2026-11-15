# sort: options the simulator does not support print the [sim] notice.
% echo a > a
$ sort -R a
[sim] sort: the flag -R is not simulated yet
[exit 250]
$ sort --sort=random a
[sim] sort: the flag --sort=random is not simulated yet
[exit 250]
$ sort -k1R a
[sim] sort: random sorting (R) is not simulated yet
[exit 250]
$ sort -S 10M a
[sim] sort: the flag -S is not simulated yet
[exit 250]
$ sort -T /tmp a
[sim] sort: the flag -T is not simulated yet
[exit 250]
$ sort --parallel=2 a
[sim] sort: the flag --parallel is not simulated yet
[exit 250]
$ sort --debug a
[sim] sort: the flag --debug is not simulated yet
[exit 250]
$ sort -z a
[sim] sort: the flag -z is not simulated yet
[exit 250]
$ sort +1 a
[sim] sort: the obsolete key form +1 is not simulated yet
[exit 250]
$ sort --version
[sim] sort: the flag --version is not simulated yet
[exit 250]
