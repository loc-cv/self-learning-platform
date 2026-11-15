# chown: what the simulator does not model prints the notice before anything changes.
# The VFS has no lchown(2), so changing a symbolic link itself (-h, or a link inside a tree with -R)
# is not simulated; -L is not simulated either. Not golden: the real chown behaves differently.
% touch a; ln -s a sl; mkdir d; ln -s ../a d/l
$ chown -h :sudo sl
[sim] chown: changing the owner of the symbolic link sl itself is not simulated yet
[sim] the simulator cannot change a link itself (lchown); without -h chown changes what the link points to
[exit 250]
$ chown -R :sudo d
[sim] chown: changing the owner of the symbolic link d/l itself is not simulated yet
[sim] the simulator cannot change a link itself (lchown); without -h chown changes what the link points to
[exit 250]
$ chown -R :sudo sl
[sim] chown: changing the owner of the symbolic link sl itself is not simulated yet
[sim] the simulator cannot change a link itself (lchown); without -h chown changes what the link points to
[exit 250]
$ chown -RL :sudo d
[sim] chown: the flag -L is not simulated yet
[exit 250]
# Nothing changed above; -H follows the links instead, and an empty spec changes nothing at all.
$ chown -v :1000 a
group of 'a' retained as student
$ chown -RH :sudo d; chown -cR "" d; chown -hv "" sl
ownership of 'sl' retained
$ chown -c :1000 a
changed group of 'a' from sudo to 1000
