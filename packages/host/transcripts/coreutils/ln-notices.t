# ln: backups and questions are not simulated.
% touch a b
$ ln -b a b
[sim] ln: the flag -b is not simulated yet
[exit 250]
$ ln --backup=numbered a b
[sim] ln: the flag --backup is not simulated yet
[exit 250]
$ ln -S .bak a b
[sim] ln: the flag -S is not simulated yet
[exit 250]
$ ln -i a b
[sim] ln: answering ln's question "ln: replace 'b'?" is not simulated yet
[sim] use ln -f to replace without asking
[exit 250]
$ ln -si a c; echo $?
0
