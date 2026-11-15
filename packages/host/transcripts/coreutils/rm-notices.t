# rm: questions are not simulated; the refusal to work on / is.
# The two lines of the refusal are upstream's ROOT_DEV_INO_WARN (coreutils 9.4 src/root-dev-ino.h),
# whose format strings are in the workstation's /usr/bin/rm and whose output is captured from
# `chmod -R --preserve-root 755 /` and `chown -R --preserve-root`, which share the macro
# (chmod.t, chown.t). rm -r / is never run on the workstation. (source-derived)
$ rm -r /
rm: it is dangerous to operate recursively on '/'
rm: use --no-preserve-root to override this failsafe
[exit 1]
$ rm -rf /
rm: it is dangerous to operate recursively on '/'
rm: use --no-preserve-root to override this failsafe
[exit 1]
$ rm -rf //
rm: it is dangerous to operate recursively on '//' (same as '/')
rm: use --no-preserve-root to override this failsafe
[exit 1]
$ rm -rf /..
rm: refusing to remove '.' or '..' directory: skipping '/..'
[exit 1]
$ touch p; chmod 444 p; rm p
[sim] rm: answering rm's question "rm: remove write-protected regular empty file 'p'?" is not simulated yet
[sim] use rm -f to remove without asking
[exit 250]
$ mkdir w; chmod 555 w; rm -r w
[sim] rm: answering rm's question "rm: remove write-protected directory 'w'?" is not simulated yet
[sim] use rm -f to remove without asking
[exit 250]
$ rm -i p
[sim] rm: interactive removal (-i, --interactive) is not simulated yet
[sim] use rm -f to remove without asking
[exit 250]
$ touch a b c d; rm -I a b c d
[sim] rm: answering rm's question "rm: remove 4 arguments?" is not simulated yet
[sim] use rm -f to remove without asking
[exit 250]
$ rm -rI w
[sim] rm: answering rm's question "rm: remove 1 argument recursively?" is not simulated yet
[sim] use rm -f to remove without asking
[exit 250]
$ rm --one-file-system p
[sim] rm: the flag --one-file-system is not simulated yet
[exit 250]
$ rm --preserve-root=all p
[sim] rm: the flag --preserve-root=all is not simulated yet
[exit 250]
$ rm -f p; echo $?
0
