# cp: options and questions the simulator does not support.
% printf 'hi\n' > a; touch b
$ cp -i a b
[sim] cp: answering cp's question "cp: overwrite 'b'?" is not simulated yet
[sim] use cp -f, or -n to skip existing files
[exit 250]
$ cp -i a c; echo $?
0
$ cp --backup a b
[sim] cp: the flag --backup is not simulated yet
[exit 250]
$ cp --parents a b
[sim] cp: the flag --parents is not simulated yet
[exit 250]
$ cp --preserve=context a c2
[sim] cp: the flag --preserve=context is not simulated yet
[sim] security contexts are not modeled
[exit 250]
$ cp --reflink a c3
[sim] cp: the flag --reflink is not simulated yet
[exit 250]
$ cp --sparse=always a c4
[sim] cp: the flag --sparse is not simulated yet
[exit 250]
$ cp -x a c5
[sim] cp: the flag -x is not simulated yet
[exit 250]
$ cp --debug a c6
[sim] cp: the flag --debug is not simulated yet
[exit 250]
$ cp -Z a c7
[sim] cp: the flag -Z is not simulated yet
[exit 250]
$ cp -r /dev/null d
[sim] cp: copying the special file '/dev/null' (mknod) is not simulated yet
[exit 250]
