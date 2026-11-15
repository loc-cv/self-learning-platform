# chmod: octal and symbolic modes, -v/-c, -R, --reference, errors, the umask surprise.
# tags: golden-verified
% : > f; : > g; mkdir d; : > d/a
$ chmod
chmod: missing operand
Try 'chmod --help' for more information.
[exit 1]
$ chmod 644
chmod: missing operand after ‘644’
Try 'chmod --help' for more information.
[exit 1]
$ chmod -v 755 f; chmod -v 755 f; chmod -c 700 f; chmod -c 700 f
mode of 'f' changed from 0644 (rw-r--r--) to 0755 (rwxr-xr-x)
mode of 'f' retained as 0755 (rwxr-xr-x)
mode of 'f' changed from 0755 (rwxr-xr-x) to 0700 (rwx------)
$ chmod -v u+ f
mode of 'f' retained as 0700 (rwx------)
$ chmod -v a-x,g+w f
mode of 'f' changed from 0700 (rwx------) to 0620 (rw--w----)
$ chmod -v +x f; chmod -v o=u f; chmod -v go-rwx f
mode of 'f' changed from 0620 (rw--w----) to 0731 (rwx-wx--x)
mode of 'f' changed from 0731 (rwx-wx--x) to 0737 (rwx-wxrwx)
mode of 'f' changed from 0737 (rwx-wxrwx) to 0700 (rwx------)
$ chmod -v -w f; echo $?
mode of 'f' changed from 0700 (rwx------) to 0500 (r-x------)
0
$ chmod -v =r f
mode of 'f' changed from 0500 (r-x------) to 0444 (r--r--r--)
$ chmod -v u+s,g+s,+t f
mode of 'f' changed from 0444 (r--r--r--) to 7444 (r-Sr-Sr-T)
$ chmod -v 0 f; chmod -v 4755 f; chmod -v 2755 d; chmod -v 755 d
mode of 'f' changed from 7444 (r-Sr-Sr-T) to 0000 (---------)
mode of 'f' changed from 0000 (---------) to 4755 (rwsr-xr-x)
mode of 'd' changed from 0755 (rwxr-xr-x) to 2755 (rwxr-sr-x)
mode of 'd' retained as 2755 (rwxr-sr-x)
$ chmod -v 00755 d; chmod -v =755 d
mode of 'd' changed from 2755 (rwxr-sr-x) to 0755 (rwxr-xr-x)
mode of 'd' retained as 0755 (rwxr-xr-x)
$ chmod -v a+X f d
mode of 'f' retained as 4755 (rwsr-xr-x)
mode of 'd' retained as 0755 (rwxr-xr-x)
$ chmod -v 999 f
chmod: invalid mode: ‘999’
Try 'chmod --help' for more information.
[exit 1]
$ chmod -v u+q f
chmod: invalid mode: ‘u+q’
Try 'chmod --help' for more information.
[exit 1]
$ chmod -v 755 nope
chmod: cannot access 'nope': No such file or directory
'nope' could not be accessed
[exit 1]
$ chmod -f 755 nope
[exit 1]
$ chmod -vR 700 d
mode of 'd' changed from 0755 (rwxr-xr-x) to 0700 (rwx------)
mode of 'd/a' changed from 0644 (rw-r--r--) to 0700 (rwx------)
$ chmod -cR go+r d
mode of 'd' changed from 0700 (rwx------) to 0744 (rwxr--r--)
mode of 'd/a' changed from 0700 (rwx------) to 0744 (rwxr--r--)
$ chmod --reference=f g; chmod -v u+ g
mode of 'g' retained as 4755 (rwsr-xr-x)
$ chmod --reference=nope g
chmod: failed to get attributes of 'nope': No such file or directory
[exit 1]
$ chmod -v u+ /etc/passwd
chmod: changing permissions of '/etc/passwd': Operation not permitted
failed to change mode of '/etc/passwd' from 0644 (rw-r--r--) to 0644 (rw-r--r--)
[exit 1]
$ chmod 644 /etc/passwd
chmod: changing permissions of '/etc/passwd': Operation not permitted
[exit 1]
$ chmod -vf 644 /etc/passwd
failed to change mode of '/etc/passwd' from 0644 (rw-r--r--) to 0644 (rw-r--r--)
[exit 1]
$ chmod -R --preserve-root 755 /
chmod: it is dangerous to operate recursively on '/'
chmod: use --no-preserve-root to override this failsafe
[exit 1]
$ chmod -v 7777 f; chmod -v 0 f
mode of 'f' changed from 4755 (rwsr-xr-x) to 7777 (rwsrwsrwt)
mode of 'f' changed from 7777 (rwsrwsrwt) to 0000 (---------)
$ chmod -v u=rwx,g=rx,o= f
mode of 'f' changed from 0000 (---------) to 0750 (rwxr-x---)
$ chmod -v ug=rw-x f
mode of 'f' changed from 0750 (rwxr-x---) to 0660 (rw-rw----)
$ chmod -v go=u-w f
mode of 'f' changed from 0660 (rw-rw----) to 0644 (rw-r--r--)
$ chmod -v 1777 d
mode of 'd' changed from 0744 (rwxr--r--) to 1777 (rwxrwxrwt)
$ chmod -v -t d
mode of 'd' changed from 1777 (rwxrwxrwt) to 0777 (rwxrwxrwx)
# The umask hides bits from a mode without "who"; chmod says so.
$ chmod 666 f; chmod -w f
chmod: f: new permissions are r--rw-rw-, not r--r--r--
[exit 1]
$ chmod 666 f; chmod -v -w f
mode of 'f' changed from 0666 (rw-rw-rw-) to 0466 (r--rw-rw-)
chmod: f: new permissions are r--rw-rw-, not r--r--r--
[exit 1]
$ chmod -v a-w f
mode of 'f' changed from 0466 (r--rw-rw-) to 0444 (r--r--r--)
$ chmod -v 644 f nope f
mode of 'f' changed from 0444 (r--r--r--) to 0644 (rw-r--r--)
chmod: cannot access 'nope': No such file or directory
'nope' could not be accessed
mode of 'f' retained as 0644 (rw-r--r--)
[exit 1]
$ chmod -v u+ f -v; chmod -- -w f; echo $?
mode of 'f' retained as 0644 (rw-r--r--)
0
$ chmod -x -v f
mode of 'f' retained as 0444 (r--r--r--)
$ chmod u+x,-r f -v
mode of 'f' changed from 0444 (r--r--r--) to 0100 (--x------)
$ chmod -w; chmod -r
chmod: missing operand
Try 'chmod --help' for more information.
chmod: missing operand
Try 'chmod --help' for more information.
[exit 1]
$ chmod --reference=f 644 g
chmod: cannot access '644': No such file or directory
[exit 1]
$ chmod -Z 644 f
chmod: invalid option -- 'Z'
Try 'chmod --help' for more information.
[exit 1]
# Symbolic links: followed on the command line, skipped inside a tree.
% ln -s f l; ln -s nowhere dl; mkdir e; ln -s ../f e/l
$ chmod -v 600 l; chmod -v 600 dl
mode of 'l' changed from 0100 (--x------) to 0600 (rw-------)
chmod: cannot operate on dangling symlink 'dl'
'dl' could not be accessed
[exit 1]
$ chmod -vR 750 e
mode of 'e' changed from 0755 (rwxr-xr-x) to 0750 (rwxr-x---)
neither symbolic link 'e/l' nor referent has been changed
$ chmod -vR 640 e
mode of 'e' changed from 0750 (rwxr-x---) to 0640 (rw-r-----)
chmod: cannot access 'e/l': Permission denied
'e/l' could not be accessed
[exit 1]
$ chmod 750 e; chmod -R 644 dl
chmod: cannot operate on dangling symlink 'dl'
[exit 1]
# A directory loses its permissions before it is read.
% mkdir d2; : > d2/a; chmod 000 d2
$ chmod -R 755 d2; echo $?
0
$ chmod -R 000 d2; echo $?
chmod: cannot read directory 'd2': Permission denied
1
% chmod 700 d2
