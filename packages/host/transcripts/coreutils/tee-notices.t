# tee: options the simulator does not support print the [sim] notice.
$ echo x | tee -p f
[sim] tee: the flag -p is not simulated yet
[exit 250]
$ echo x | tee --output-error=warn f
[sim] tee: the flag --output-error is not simulated yet
[exit 250]
$ tee --version
[sim] tee: the flag --version is not simulated yet
[exit 250]
