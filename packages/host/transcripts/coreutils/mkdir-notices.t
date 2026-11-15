# mkdir: options the simulator does not support print the [sim] notice.
$ mkdir -Z x
[sim] mkdir: the flag -Z is not simulated yet
[exit 250]
$ mkdir --context=x y
[sim] mkdir: the flag --context is not simulated yet
[exit 250]
$ mkdir --version
[sim] mkdir: the flag --version is not simulated yet
[exit 250]
