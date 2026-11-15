# hostname: the kernel's host name, setting it as an ordinary user, the NIS domain, usage errors.
# (-s, -f, -d and friends depend on the workstation's own name and resolver: see hostname.test.ts.)
# tags: golden-verified
$ hostname
node01
$ hostname --boot
node01
$ hostname newname; echo $?
hostname: you must be root to change the host name
1
$ hostname -b newname; echo $?
hostname: you must be root to change the host name
1
$ hostname ''; echo $?
hostname: the specified hostname is invalid
1
$ hostname -F /nope; echo $?
hostname: No such file or directory
1
$ hostname -F /etc/hostname; echo $?
hostname: you must be root to change the host name
1
$ hostname -y; echo $?
hostname: Local domain name not set
1
$ hostname --nis; echo $?
hostname: Local domain name not set
1
$ hostname -y newdomain; echo $?
hostname: you must be root to change the domain name
1
$ domainname; echo $?
(none)
0
$ domainname x; echo $?
domainname: you must be root to change the domain name
1
$ nisdomainname; echo $?
nisdomainname: Local domain name not set
1
$ hostname -V
hostname 3.23
$ hostname -x | head -3
hostname: invalid option -- 'x'
Usage: hostname [-b] {hostname|-F file}         set host name (from file)
       hostname [-a|-A|-d|-f|-i|-I|-s|-y]       display formatted name
       hostname                                 display host name
$ hostname -h | head -2
Usage: hostname [-b] {hostname|-F file}         set host name (from file)
       hostname [-a|-A|-d|-f|-i|-I|-s|-y]       display formatted name
$ hostname a b 2>&1 | head -2
Usage: hostname [-b] {hostname|-F file}         set host name (from file)
       hostname [-a|-A|-d|-f|-i|-I|-s|-y]       display formatted name
