# mv: backups, contexts and questions are not simulated.
% printf 'hi\n' > a; touch b
$ mv -i a b
[sim] mv: answering mv's question "mv: overwrite 'b'?" is not simulated yet
[sim] use mv -f to replace without asking
[exit 250]
$ mv -i a c; echo $?
0
$ touch p; chmod 444 p; mv c p
[sim] mv: answering mv's question "mv: replace 'p', overriding mode 0444 (r--r--r--)?" is not simulated yet
[sim] use mv -f to replace without asking
[exit 250]
$ mv -b c b
[sim] mv: the flag -b is not simulated yet
[exit 250]
$ mv -Z c b
[sim] mv: the flag -Z is not simulated yet
[exit 250]
