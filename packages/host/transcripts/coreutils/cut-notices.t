# cut: options the simulator does not support print the [sim] notice.
% echo a > a
$ cut -z -f1 a
[sim] cut: the flag -z is not simulated yet
[exit 250]
$ cut --version
[sim] cut: the flag --version is not simulated yet
[exit 250]
