# ls -l: mode strings, link counts, owners, sizes (-h, --si, --block-size), allocated blocks (-s,
# total), dates (recent, older than six months, in the future), time styles, -g -o -n -G, sorting
# by time and size, unreadable directories.
# tags: golden-verified
% mkdir s && cd s && printf '%5000s' x > big && printf '' > empty && printf '%1500000s' x > huge && printf '%10000s' x > tenk && printf '%1023s' x > k1 && printf '%1024s' x > k2 && printf '%1025s' x > k3 && mkdir dir
% touch -d '2026-11-10 08:30:00' huge tenk k1 k2 k3 dir && touch -d '2025-01-02 03:04:05' big && touch -d '2027-03-01 00:00:00' empty && touch -d '2026-11-12 23:59:00' .
$ ls -l
total 1504
-rw-r--r-- 1 student student    5000 Jan  2  2025 big
drwxr-xr-x 2 student student    4096 Nov 10 08:30 dir
-rw-r--r-- 1 student student       0 Mar  1  2027 empty
-rw-r--r-- 1 student student 1500000 Nov 10 08:30 huge
-rw-r--r-- 1 student student    1023 Nov 10 08:30 k1
-rw-r--r-- 1 student student    1024 Nov 10 08:30 k2
-rw-r--r-- 1 student student    1025 Nov 10 08:30 k3
-rw-r--r-- 1 student student   10000 Nov 10 08:30 tenk
$ ls -lh
total 1.5M
-rw-r--r-- 1 student student 4.9K Jan  2  2025 big
drwxr-xr-x 2 student student 4.0K Nov 10 08:30 dir
-rw-r--r-- 1 student student    0 Mar  1  2027 empty
-rw-r--r-- 1 student student 1.5M Nov 10 08:30 huge
-rw-r--r-- 1 student student 1023 Nov 10 08:30 k1
-rw-r--r-- 1 student student 1.0K Nov 10 08:30 k2
-rw-r--r-- 1 student student 1.1K Nov 10 08:30 k3
-rw-r--r-- 1 student student 9.8K Nov 10 08:30 tenk
$ ls -ls
total 1504
   8 -rw-r--r-- 1 student student    5000 Jan  2  2025 big
   4 drwxr-xr-x 2 student student    4096 Nov 10 08:30 dir
   0 -rw-r--r-- 1 student student       0 Mar  1  2027 empty
1468 -rw-r--r-- 1 student student 1500000 Nov 10 08:30 huge
   4 -rw-r--r-- 1 student student    1023 Nov 10 08:30 k1
   4 -rw-r--r-- 1 student student    1024 Nov 10 08:30 k2
   4 -rw-r--r-- 1 student student    1025 Nov 10 08:30 k3
  12 -rw-r--r-- 1 student student   10000 Nov 10 08:30 tenk
$ ls -lsh
total 1.5M
8.0K -rw-r--r-- 1 student student 4.9K Jan  2  2025 big
4.0K drwxr-xr-x 2 student student 4.0K Nov 10 08:30 dir
   0 -rw-r--r-- 1 student student    0 Mar  1  2027 empty
1.5M -rw-r--r-- 1 student student 1.5M Nov 10 08:30 huge
4.0K -rw-r--r-- 1 student student 1023 Nov 10 08:30 k1
4.0K -rw-r--r-- 1 student student 1.0K Nov 10 08:30 k2
4.0K -rw-r--r-- 1 student student 1.1K Nov 10 08:30 k3
 12K -rw-r--r-- 1 student student 9.8K Nov 10 08:30 tenk
$ ls -s
total 1504
   8 big     4 dir     0 empty	1468 huge     4 k1     4 k2     4 k3    12 tenk
$ ls -sh
total 1.5M
8.0K big  4.0K dir     0 empty	1.5M huge  4.0K k1  4.0K k2  4.0K k3   12K tenk
$ ls -s1
total 1504
   8 big
   4 dir
   0 empty
1468 huge
   4 k1
   4 k2
   4 k3
  12 tenk
$ ls -sm
total 1504
8 big, 4 dir, 0 empty, 1468 huge, 4 k1, 4 k2, 4 k3, 12 tenk
$ ls -l --si
total 1.6M
-rw-r--r-- 1 student student 5.0k Jan  2  2025 big
drwxr-xr-x 2 student student 4.1k Nov 10 08:30 dir
-rw-r--r-- 1 student student    0 Mar  1  2027 empty
-rw-r--r-- 1 student student 1.5M Nov 10 08:30 huge
-rw-r--r-- 1 student student 1.1k Nov 10 08:30 k1
-rw-r--r-- 1 student student 1.1k Nov 10 08:30 k2
-rw-r--r-- 1 student student 1.1k Nov 10 08:30 k3
-rw-r--r-- 1 student student  10k Nov 10 08:30 tenk
$ ls -lk
total 1504
-rw-r--r-- 1 student student    5000 Jan  2  2025 big
drwxr-xr-x 2 student student    4096 Nov 10 08:30 dir
-rw-r--r-- 1 student student       0 Mar  1  2027 empty
-rw-r--r-- 1 student student 1500000 Nov 10 08:30 huge
-rw-r--r-- 1 student student    1023 Nov 10 08:30 k1
-rw-r--r-- 1 student student    1024 Nov 10 08:30 k2
-rw-r--r-- 1 student student    1025 Nov 10 08:30 k3
-rw-r--r-- 1 student student   10000 Nov 10 08:30 tenk
$ ls -l --block-size=K
total 1504K
-rw-r--r-- 1 student student    5K Jan  2  2025 big
drwxr-xr-x 2 student student    4K Nov 10 08:30 dir
-rw-r--r-- 1 student student    0K Mar  1  2027 empty
-rw-r--r-- 1 student student 1465K Nov 10 08:30 huge
-rw-r--r-- 1 student student    1K Nov 10 08:30 k1
-rw-r--r-- 1 student student    1K Nov 10 08:30 k2
-rw-r--r-- 1 student student    2K Nov 10 08:30 k3
-rw-r--r-- 1 student student   10K Nov 10 08:30 tenk
$ ls -ls --block-size=1K
total 1504
   8 -rw-r--r-- 1 student student    5 Jan  2  2025 big
   4 drwxr-xr-x 2 student student    4 Nov 10 08:30 dir
   0 -rw-r--r-- 1 student student    0 Mar  1  2027 empty
1468 -rw-r--r-- 1 student student 1465 Nov 10 08:30 huge
   4 -rw-r--r-- 1 student student    1 Nov 10 08:30 k1
   4 -rw-r--r-- 1 student student    1 Nov 10 08:30 k2
   4 -rw-r--r-- 1 student student    2 Nov 10 08:30 k3
  12 -rw-r--r-- 1 student student   10 Nov 10 08:30 tenk
$ ls -l --block-size=M
total 2M
-rw-r--r-- 1 student student 1M Jan  2  2025 big
drwxr-xr-x 2 student student 1M Nov 10 08:30 dir
-rw-r--r-- 1 student student 0M Mar  1  2027 empty
-rw-r--r-- 1 student student 2M Nov 10 08:30 huge
-rw-r--r-- 1 student student 1M Nov 10 08:30 k1
-rw-r--r-- 1 student student 1M Nov 10 08:30 k2
-rw-r--r-- 1 student student 1M Nov 10 08:30 k3
-rw-r--r-- 1 student student 1M Nov 10 08:30 tenk
$ ls -ls --block-size=KB
total 1541kB
   9kB -rw-r--r-- 1 student student    5kB Jan  2  2025 big
   5kB drwxr-xr-x 2 student student    5kB Nov 10 08:30 dir
   0kB -rw-r--r-- 1 student student    0kB Mar  1  2027 empty
1504kB -rw-r--r-- 1 student student 1500kB Nov 10 08:30 huge
   5kB -rw-r--r-- 1 student student    2kB Nov 10 08:30 k1
   5kB -rw-r--r-- 1 student student    2kB Nov 10 08:30 k2
   5kB -rw-r--r-- 1 student student    2kB Nov 10 08:30 k3
  13kB -rw-r--r-- 1 student student   10kB Nov 10 08:30 tenk
$ ls -ls --block-size=KiB
total 1504KiB
   8KiB -rw-r--r-- 1 student student    5KiB Jan  2  2025 big
   4KiB drwxr-xr-x 2 student student    4KiB Nov 10 08:30 dir
   0KiB -rw-r--r-- 1 student student    0KiB Mar  1  2027 empty
1468KiB -rw-r--r-- 1 student student 1465KiB Nov 10 08:30 huge
   4KiB -rw-r--r-- 1 student student    1KiB Nov 10 08:30 k1
   4KiB -rw-r--r-- 1 student student    1KiB Nov 10 08:30 k2
   4KiB -rw-r--r-- 1 student student    2KiB Nov 10 08:30 k3
  12KiB -rw-r--r-- 1 student student   10KiB Nov 10 08:30 tenk
$ ls -l --block-size=1000
total 1541
-rw-r--r-- 1 student student    5 Jan  2  2025 big
drwxr-xr-x 2 student student    5 Nov 10 08:30 dir
-rw-r--r-- 1 student student    0 Mar  1  2027 empty
-rw-r--r-- 1 student student 1500 Nov 10 08:30 huge
-rw-r--r-- 1 student student    2 Nov 10 08:30 k1
-rw-r--r-- 1 student student    2 Nov 10 08:30 k2
-rw-r--r-- 1 student student    2 Nov 10 08:30 k3
-rw-r--r-- 1 student student   10 Nov 10 08:30 tenk
$ ls -l --block-size=human-readable
total 1.5M
-rw-r--r-- 1 student student 4.9K Jan  2  2025 big
drwxr-xr-x 2 student student 4.0K Nov 10 08:30 dir
-rw-r--r-- 1 student student    0 Mar  1  2027 empty
-rw-r--r-- 1 student student 1.5M Nov 10 08:30 huge
-rw-r--r-- 1 student student 1023 Nov 10 08:30 k1
-rw-r--r-- 1 student student 1.0K Nov 10 08:30 k2
-rw-r--r-- 1 student student 1.1K Nov 10 08:30 k3
-rw-r--r-- 1 student student 9.8K Nov 10 08:30 tenk
$ ls -l --block-size=si
total 1.6M
-rw-r--r-- 1 student student 5.0k Jan  2  2025 big
drwxr-xr-x 2 student student 4.1k Nov 10 08:30 dir
-rw-r--r-- 1 student student    0 Mar  1  2027 empty
-rw-r--r-- 1 student student 1.5M Nov 10 08:30 huge
-rw-r--r-- 1 student student 1.1k Nov 10 08:30 k1
-rw-r--r-- 1 student student 1.1k Nov 10 08:30 k2
-rw-r--r-- 1 student student 1.1k Nov 10 08:30 k3
-rw-r--r-- 1 student student  10k Nov 10 08:30 tenk
$ BLOCK_SIZE=M ls -ls
total 2M
1M -rw-r--r-- 1 student student 1M Jan  2  2025 big
1M drwxr-xr-x 2 student student 1M Nov 10 08:30 dir
0M -rw-r--r-- 1 student student 0M Mar  1  2027 empty
2M -rw-r--r-- 1 student student 2M Nov 10 08:30 huge
1M -rw-r--r-- 1 student student 1M Nov 10 08:30 k1
1M -rw-r--r-- 1 student student 1M Nov 10 08:30 k2
1M -rw-r--r-- 1 student student 1M Nov 10 08:30 k3
1M -rw-r--r-- 1 student student 1M Nov 10 08:30 tenk
$ LS_BLOCK_SIZE=K BLOCK_SIZE=M ls -ls
total 1504K
   8K -rw-r--r-- 1 student student    5K Jan  2  2025 big
   4K drwxr-xr-x 2 student student    4K Nov 10 08:30 dir
   0K -rw-r--r-- 1 student student    0K Mar  1  2027 empty
1468K -rw-r--r-- 1 student student 1465K Nov 10 08:30 huge
   4K -rw-r--r-- 1 student student    1K Nov 10 08:30 k1
   4K -rw-r--r-- 1 student student    1K Nov 10 08:30 k2
   4K -rw-r--r-- 1 student student    2K Nov 10 08:30 k3
  12K -rw-r--r-- 1 student student   10K Nov 10 08:30 tenk
$ BLOCKSIZE=K ls -ls
total 1504K
   8K -rw-r--r-- 1 student student    5000 Jan  2  2025 big
   4K drwxr-xr-x 2 student student    4096 Nov 10 08:30 dir
   0K -rw-r--r-- 1 student student       0 Mar  1  2027 empty
1468K -rw-r--r-- 1 student student 1500000 Nov 10 08:30 huge
   4K -rw-r--r-- 1 student student    1023 Nov 10 08:30 k1
   4K -rw-r--r-- 1 student student    1024 Nov 10 08:30 k2
   4K -rw-r--r-- 1 student student    1025 Nov 10 08:30 k3
  12K -rw-r--r-- 1 student student   10000 Nov 10 08:30 tenk
$ POSIXLY_CORRECT=1 ls -ls
total 3008
  16 -rw-r--r-- 1 student student    5000 Jan  2  2025 big
   8 drwxr-xr-x 2 student student    4096 Nov 10 08:30 dir
   0 -rw-r--r-- 1 student student       0 Mar  1  2027 empty
2936 -rw-r--r-- 1 student student 1500000 Nov 10 08:30 huge
   8 -rw-r--r-- 1 student student    1023 Nov 10 08:30 k1
   8 -rw-r--r-- 1 student student    1024 Nov 10 08:30 k2
   8 -rw-r--r-- 1 student student    1025 Nov 10 08:30 k3
  24 -rw-r--r-- 1 student student   10000 Nov 10 08:30 tenk
$ POSIXLY_CORRECT=1 ls -lsk
total 1504
   8 -rw-r--r-- 1 student student    5000 Jan  2  2025 big
   4 drwxr-xr-x 2 student student    4096 Nov 10 08:30 dir
   0 -rw-r--r-- 1 student student       0 Mar  1  2027 empty
1468 -rw-r--r-- 1 student student 1500000 Nov 10 08:30 huge
   4 -rw-r--r-- 1 student student    1023 Nov 10 08:30 k1
   4 -rw-r--r-- 1 student student    1024 Nov 10 08:30 k2
   4 -rw-r--r-- 1 student student    1025 Nov 10 08:30 k3
  12 -rw-r--r-- 1 student student   10000 Nov 10 08:30 tenk
$ ls -l --block-size=X
ls: invalid --block-size argument 'X'
[exit 2]
$ ls -l --block-size=0
ls: invalid --block-size argument '0'
[exit 2]
$ ls -l --block-size=10xyz
ls: invalid suffix in --block-size argument '10xyz'
[exit 2]
#
# Sorting by time and size, reversed.
$ ls -lt
total 1504
-rw-r--r-- 1 student student       0 Mar  1  2027 empty
drwxr-xr-x 2 student student    4096 Nov 10 08:30 dir
-rw-r--r-- 1 student student 1500000 Nov 10 08:30 huge
-rw-r--r-- 1 student student    1023 Nov 10 08:30 k1
-rw-r--r-- 1 student student    1024 Nov 10 08:30 k2
-rw-r--r-- 1 student student    1025 Nov 10 08:30 k3
-rw-r--r-- 1 student student   10000 Nov 10 08:30 tenk
-rw-r--r-- 1 student student    5000 Jan  2  2025 big
$ ls -ltr
total 1504
-rw-r--r-- 1 student student    5000 Jan  2  2025 big
-rw-r--r-- 1 student student   10000 Nov 10 08:30 tenk
-rw-r--r-- 1 student student    1025 Nov 10 08:30 k3
-rw-r--r-- 1 student student    1024 Nov 10 08:30 k2
-rw-r--r-- 1 student student    1023 Nov 10 08:30 k1
-rw-r--r-- 1 student student 1500000 Nov 10 08:30 huge
drwxr-xr-x 2 student student    4096 Nov 10 08:30 dir
-rw-r--r-- 1 student student       0 Mar  1  2027 empty
$ ls -lS
total 1504
-rw-r--r-- 1 student student 1500000 Nov 10 08:30 huge
-rw-r--r-- 1 student student   10000 Nov 10 08:30 tenk
-rw-r--r-- 1 student student    5000 Jan  2  2025 big
drwxr-xr-x 2 student student    4096 Nov 10 08:30 dir
-rw-r--r-- 1 student student    1025 Nov 10 08:30 k3
-rw-r--r-- 1 student student    1024 Nov 10 08:30 k2
-rw-r--r-- 1 student student    1023 Nov 10 08:30 k1
-rw-r--r-- 1 student student       0 Mar  1  2027 empty
$ ls -lSr
total 1504
-rw-r--r-- 1 student student       0 Mar  1  2027 empty
-rw-r--r-- 1 student student    1023 Nov 10 08:30 k1
-rw-r--r-- 1 student student    1024 Nov 10 08:30 k2
-rw-r--r-- 1 student student    1025 Nov 10 08:30 k3
drwxr-xr-x 2 student student    4096 Nov 10 08:30 dir
-rw-r--r-- 1 student student    5000 Jan  2  2025 big
-rw-r--r-- 1 student student   10000 Nov 10 08:30 tenk
-rw-r--r-- 1 student student 1500000 Nov 10 08:30 huge
$ ls -t
empty  dir  huge  k1  k2  k3  tenk  big
$ ls -S
huge  tenk  big  dir  k3  k2  k1  empty
$ ls -1tr
big
tenk
k3
k2
k1
huge
dir
empty
#
# Time styles.
$ ls --full-time
total 1504
-rw-r--r-- 1 student student    5000 2025-01-02 03:04:05.000000000 +0000 big
drwxr-xr-x 2 student student    4096 2026-11-10 08:30:00.000000000 +0000 dir
-rw-r--r-- 1 student student       0 2027-03-01 00:00:00.000000000 +0000 empty
-rw-r--r-- 1 student student 1500000 2026-11-10 08:30:00.000000000 +0000 huge
-rw-r--r-- 1 student student    1023 2026-11-10 08:30:00.000000000 +0000 k1
-rw-r--r-- 1 student student    1024 2026-11-10 08:30:00.000000000 +0000 k2
-rw-r--r-- 1 student student    1025 2026-11-10 08:30:00.000000000 +0000 k3
-rw-r--r-- 1 student student   10000 2026-11-10 08:30:00.000000000 +0000 tenk
$ ls -l --time-style=full-iso
total 1504
-rw-r--r-- 1 student student    5000 2025-01-02 03:04:05.000000000 +0000 big
drwxr-xr-x 2 student student    4096 2026-11-10 08:30:00.000000000 +0000 dir
-rw-r--r-- 1 student student       0 2027-03-01 00:00:00.000000000 +0000 empty
-rw-r--r-- 1 student student 1500000 2026-11-10 08:30:00.000000000 +0000 huge
-rw-r--r-- 1 student student    1023 2026-11-10 08:30:00.000000000 +0000 k1
-rw-r--r-- 1 student student    1024 2026-11-10 08:30:00.000000000 +0000 k2
-rw-r--r-- 1 student student    1025 2026-11-10 08:30:00.000000000 +0000 k3
-rw-r--r-- 1 student student   10000 2026-11-10 08:30:00.000000000 +0000 tenk
$ ls -l --time-style=long-iso
total 1504
-rw-r--r-- 1 student student    5000 2025-01-02 03:04 big
drwxr-xr-x 2 student student    4096 2026-11-10 08:30 dir
-rw-r--r-- 1 student student       0 2027-03-01 00:00 empty
-rw-r--r-- 1 student student 1500000 2026-11-10 08:30 huge
-rw-r--r-- 1 student student    1023 2026-11-10 08:30 k1
-rw-r--r-- 1 student student    1024 2026-11-10 08:30 k2
-rw-r--r-- 1 student student    1025 2026-11-10 08:30 k3
-rw-r--r-- 1 student student   10000 2026-11-10 08:30 tenk
$ ls -l --time-style=iso
total 1504
-rw-r--r-- 1 student student    5000 2025-01-02  big
drwxr-xr-x 2 student student    4096 11-10 08:30 dir
-rw-r--r-- 1 student student       0 2027-03-01  empty
-rw-r--r-- 1 student student 1500000 11-10 08:30 huge
-rw-r--r-- 1 student student    1023 11-10 08:30 k1
-rw-r--r-- 1 student student    1024 11-10 08:30 k2
-rw-r--r-- 1 student student    1025 11-10 08:30 k3
-rw-r--r-- 1 student student   10000 11-10 08:30 tenk
$ ls -l --time-style=locale
total 1504
-rw-r--r-- 1 student student    5000 Jan  2  2025 big
drwxr-xr-x 2 student student    4096 Nov 10 08:30 dir
-rw-r--r-- 1 student student       0 Mar  1  2027 empty
-rw-r--r-- 1 student student 1500000 Nov 10 08:30 huge
-rw-r--r-- 1 student student    1023 Nov 10 08:30 k1
-rw-r--r-- 1 student student    1024 Nov 10 08:30 k2
-rw-r--r-- 1 student student    1025 Nov 10 08:30 k3
-rw-r--r-- 1 student student   10000 Nov 10 08:30 tenk
$ ls -l --time-style=posix-long-iso
total 1504
-rw-r--r-- 1 student student    5000 2025-01-02 03:04 big
drwxr-xr-x 2 student student    4096 2026-11-10 08:30 dir
-rw-r--r-- 1 student student       0 2027-03-01 00:00 empty
-rw-r--r-- 1 student student 1500000 2026-11-10 08:30 huge
-rw-r--r-- 1 student student    1023 2026-11-10 08:30 k1
-rw-r--r-- 1 student student    1024 2026-11-10 08:30 k2
-rw-r--r-- 1 student student    1025 2026-11-10 08:30 k3
-rw-r--r-- 1 student student   10000 2026-11-10 08:30 tenk
$ ls -l --time-style=+%Y/%m/%d
total 1504
-rw-r--r-- 1 student student    5000 2025/01/02 big
drwxr-xr-x 2 student student    4096 2026/11/10 dir
-rw-r--r-- 1 student student       0 2027/03/01 empty
-rw-r--r-- 1 student student 1500000 2026/11/10 huge
-rw-r--r-- 1 student student    1023 2026/11/10 k1
-rw-r--r-- 1 student student    1024 2026/11/10 k2
-rw-r--r-- 1 student student    1025 2026/11/10 k3
-rw-r--r-- 1 student student   10000 2026/11/10 tenk
$ ls -l '--time-style=+[%F %T] %a %b %e %H:%M:%S %j %y %A %B'
total 1504
-rw-r--r-- 1 student student    5000 [2025-01-02 03:04:05] Thu Jan  2 03:04:05 002 25 Thursday January big
drwxr-xr-x 2 student student    4096 [2026-11-10 08:30:00] Tue Nov 10 08:30:00 314 26 Tuesday November dir
-rw-r--r-- 1 student student       0 [2027-03-01 00:00:00] Mon Mar  1 00:00:00 060 27 Monday March empty
-rw-r--r-- 1 student student 1500000 [2026-11-10 08:30:00] Tue Nov 10 08:30:00 314 26 Tuesday November huge
-rw-r--r-- 1 student student    1023 [2026-11-10 08:30:00] Tue Nov 10 08:30:00 314 26 Tuesday November k1
-rw-r--r-- 1 student student    1024 [2026-11-10 08:30:00] Tue Nov 10 08:30:00 314 26 Tuesday November k2
-rw-r--r-- 1 student student    1025 [2026-11-10 08:30:00] Tue Nov 10 08:30:00 314 26 Tuesday November k3
-rw-r--r-- 1 student student   10000 [2026-11-10 08:30:00] Tue Nov 10 08:30:00 314 26 Tuesday November tenk
$ ls -l --time-style=+%s
total 1504
-rw-r--r-- 1 student student    5000 1735787045 big
drwxr-xr-x 2 student student    4096 1794299400 dir
-rw-r--r-- 1 student student       0 1803859200 empty
-rw-r--r-- 1 student student 1500000 1794299400 huge
-rw-r--r-- 1 student student    1023 1794299400 k1
-rw-r--r-- 1 student student    1024 1794299400 k2
-rw-r--r-- 1 student student    1025 1794299400 k3
-rw-r--r-- 1 student student   10000 1794299400 tenk
$ ls -l --time-style=+%Q
total 1504
-rw-r--r-- 1 student student    5000 %Q big
drwxr-xr-x 2 student student    4096 %Q dir
-rw-r--r-- 1 student student       0 %Q empty
-rw-r--r-- 1 student student 1500000 %Q huge
-rw-r--r-- 1 student student    1023 %Q k1
-rw-r--r-- 1 student student    1024 %Q k2
-rw-r--r-- 1 student student    1025 %Q k3
-rw-r--r-- 1 student student   10000 %Q tenk
$ TIME_STYLE=long-iso ls -l
total 1504
-rw-r--r-- 1 student student    5000 2025-01-02 03:04 big
drwxr-xr-x 2 student student    4096 2026-11-10 08:30 dir
-rw-r--r-- 1 student student       0 2027-03-01 00:00 empty
-rw-r--r-- 1 student student 1500000 2026-11-10 08:30 huge
-rw-r--r-- 1 student student    1023 2026-11-10 08:30 k1
-rw-r--r-- 1 student student    1024 2026-11-10 08:30 k2
-rw-r--r-- 1 student student    1025 2026-11-10 08:30 k3
-rw-r--r-- 1 student student   10000 2026-11-10 08:30 tenk
$ TIME_STYLE=iso ls -l --time-style=locale
total 1504
-rw-r--r-- 1 student student    5000 Jan  2  2025 big
drwxr-xr-x 2 student student    4096 Nov 10 08:30 dir
-rw-r--r-- 1 student student       0 Mar  1  2027 empty
-rw-r--r-- 1 student student 1500000 Nov 10 08:30 huge
-rw-r--r-- 1 student student    1023 Nov 10 08:30 k1
-rw-r--r-- 1 student student    1024 Nov 10 08:30 k2
-rw-r--r-- 1 student student    1025 Nov 10 08:30 k3
-rw-r--r-- 1 student student   10000 Nov 10 08:30 tenk
$ ls -l --time-style=bogus
ls: invalid argument ‘bogus’ for ‘time style’
Valid arguments are:
  - [posix-]full-iso
  - [posix-]long-iso
  - [posix-]iso
  - [posix-]locale
  - +FORMAT (e.g., +%H:%M) for a 'date'-style format
Try 'ls --help' for more information.
[exit 2]
$ ls --time-style=bogus
big  dir  empty  huge  k1  k2  k3  tenk
$ TIME_STYLE=bogus ls -l
ls: invalid argument ‘bogus’ for ‘time style’
Valid arguments are:
  - [posix-]full-iso
  - [posix-]long-iso
  - [posix-]iso
  - [posix-]locale
  - +FORMAT (e.g., +%H:%M) for a 'date'-style format
Try 'ls --help' for more information.
[exit 2]
#
# Columns left out and numeric ids.
$ ls -g
total 1504
-rw-r--r-- 1 student    5000 Jan  2  2025 big
drwxr-xr-x 2 student    4096 Nov 10 08:30 dir
-rw-r--r-- 1 student       0 Mar  1  2027 empty
-rw-r--r-- 1 student 1500000 Nov 10 08:30 huge
-rw-r--r-- 1 student    1023 Nov 10 08:30 k1
-rw-r--r-- 1 student    1024 Nov 10 08:30 k2
-rw-r--r-- 1 student    1025 Nov 10 08:30 k3
-rw-r--r-- 1 student   10000 Nov 10 08:30 tenk
$ ls -o
total 1504
-rw-r--r-- 1 student    5000 Jan  2  2025 big
drwxr-xr-x 2 student    4096 Nov 10 08:30 dir
-rw-r--r-- 1 student       0 Mar  1  2027 empty
-rw-r--r-- 1 student 1500000 Nov 10 08:30 huge
-rw-r--r-- 1 student    1023 Nov 10 08:30 k1
-rw-r--r-- 1 student    1024 Nov 10 08:30 k2
-rw-r--r-- 1 student    1025 Nov 10 08:30 k3
-rw-r--r-- 1 student   10000 Nov 10 08:30 tenk
$ ls -go
total 1504
-rw-r--r-- 1    5000 Jan  2  2025 big
drwxr-xr-x 2    4096 Nov 10 08:30 dir
-rw-r--r-- 1       0 Mar  1  2027 empty
-rw-r--r-- 1 1500000 Nov 10 08:30 huge
-rw-r--r-- 1    1023 Nov 10 08:30 k1
-rw-r--r-- 1    1024 Nov 10 08:30 k2
-rw-r--r-- 1    1025 Nov 10 08:30 k3
-rw-r--r-- 1   10000 Nov 10 08:30 tenk
$ ls -n
total 1504
-rw-r--r-- 1 1000 1000    5000 Jan  2  2025 big
drwxr-xr-x 2 1000 1000    4096 Nov 10 08:30 dir
-rw-r--r-- 1 1000 1000       0 Mar  1  2027 empty
-rw-r--r-- 1 1000 1000 1500000 Nov 10 08:30 huge
-rw-r--r-- 1 1000 1000    1023 Nov 10 08:30 k1
-rw-r--r-- 1 1000 1000    1024 Nov 10 08:30 k2
-rw-r--r-- 1 1000 1000    1025 Nov 10 08:30 k3
-rw-r--r-- 1 1000 1000   10000 Nov 10 08:30 tenk
$ ls -lG
total 1504
-rw-r--r-- 1 student    5000 Jan  2  2025 big
drwxr-xr-x 2 student    4096 Nov 10 08:30 dir
-rw-r--r-- 1 student       0 Mar  1  2027 empty
-rw-r--r-- 1 student 1500000 Nov 10 08:30 huge
-rw-r--r-- 1 student    1023 Nov 10 08:30 k1
-rw-r--r-- 1 student    1024 Nov 10 08:30 k2
-rw-r--r-- 1 student    1025 Nov 10 08:30 k3
-rw-r--r-- 1 student   10000 Nov 10 08:30 tenk
$ ls -l --author
total 1504
-rw-r--r-- 1 student student student    5000 Jan  2  2025 big
drwxr-xr-x 2 student student student    4096 Nov 10 08:30 dir
-rw-r--r-- 1 student student student       0 Mar  1  2027 empty
-rw-r--r-- 1 student student student 1500000 Nov 10 08:30 huge
-rw-r--r-- 1 student student student    1023 Nov 10 08:30 k1
-rw-r--r-- 1 student student student    1024 Nov 10 08:30 k2
-rw-r--r-- 1 student student student    1025 Nov 10 08:30 k3
-rw-r--r-- 1 student student student   10000 Nov 10 08:30 tenk
$ ls -lZ
total 1504
-rw-r--r-- 1 student student ?    5000 Jan  2  2025 big
drwxr-xr-x 2 student student ?    4096 Nov 10 08:30 dir
-rw-r--r-- 1 student student ?       0 Mar  1  2027 empty
-rw-r--r-- 1 student student ? 1500000 Nov 10 08:30 huge
-rw-r--r-- 1 student student ?    1023 Nov 10 08:30 k1
-rw-r--r-- 1 student student ?    1024 Nov 10 08:30 k2
-rw-r--r-- 1 student student ?    1025 Nov 10 08:30 k3
-rw-r--r-- 1 student student ?   10000 Nov 10 08:30 tenk
$ ls -Z
? big  ? dir  ? empty  ? huge  ? k1  ? k2  ? k3  ? tenk
$ ls -ld dir .
drwxr-xr-x 3 student student 4096 Nov 12 23:59 .
drwxr-xr-x 2 student student 4096 Nov 10 08:30 dir
$ ls -l dir
total 0
$ ls -l big dir nope
ls: cannot access 'nope': No such file or directory
-rw-r--r-- 1 student student 5000 Jan  2  2025 big

dir:
total 0
[exit 2]
$ ls -l1
total 1504
-rw-r--r-- 1 student student    5000 Jan  2  2025 big
drwxr-xr-x 2 student student    4096 Nov 10 08:30 dir
-rw-r--r-- 1 student student       0 Mar  1  2027 empty
-rw-r--r-- 1 student student 1500000 Nov 10 08:30 huge
-rw-r--r-- 1 student student    1023 Nov 10 08:30 k1
-rw-r--r-- 1 student student    1024 Nov 10 08:30 k2
-rw-r--r-- 1 student student    1025 Nov 10 08:30 k3
-rw-r--r-- 1 student student   10000 Nov 10 08:30 tenk
$ ls -1l
total 1504
-rw-r--r-- 1 student student    5000 Jan  2  2025 big
drwxr-xr-x 2 student student    4096 Nov 10 08:30 dir
-rw-r--r-- 1 student student       0 Mar  1  2027 empty
-rw-r--r-- 1 student student 1500000 Nov 10 08:30 huge
-rw-r--r-- 1 student student    1023 Nov 10 08:30 k1
-rw-r--r-- 1 student student    1024 Nov 10 08:30 k2
-rw-r--r-- 1 student student    1025 Nov 10 08:30 k3
-rw-r--r-- 1 student student   10000 Nov 10 08:30 tenk
$ ls -lC
big  dir  empty  huge  k1  k2  k3  tenk
$ ls -lm
big, dir, empty, huge, k1, k2, k3, tenk
$ ls -l --format=single-column
big
dir
empty
huge
k1
k2
k3
tenk
#
# Special permission bits, and directories that cannot be read or searched.
% cd .. && mkdir m && cd m && touch f exe suid sgid su2 sg2 st2 && mkdir locked noexec sticky ow tw && touch noexec/inner
% chmod 711 exe && chmod 4755 suid && chmod 2755 sgid && chmod 4644 su2 && chmod 2644 sg2 && chmod 1644 st2 && chmod 1755 sticky && chmod 777 ow && chmod 1777 tw && chmod 644 noexec && chmod 000 locked
% touch -d '2026-11-10 08:30:00' f exe suid sgid su2 sg2 st2 locked noexec sticky ow tw
$ ls -l
total 20
-rwx--x--x 1 student student    0 Nov 10 08:30 exe
-rw-r--r-- 1 student student    0 Nov 10 08:30 f
d--------- 2 student student 4096 Nov 10 08:30 locked
drw-r--r-- 2 student student 4096 Nov 10 08:30 noexec
drwxrwxrwx 2 student student 4096 Nov 10 08:30 ow
-rw-r-Sr-- 1 student student    0 Nov 10 08:30 sg2
-rwxr-sr-x 1 student student    0 Nov 10 08:30 sgid
-rw-r--r-T 1 student student    0 Nov 10 08:30 st2
drwxr-xr-t 2 student student 4096 Nov 10 08:30 sticky
-rwSr--r-- 1 student student    0 Nov 10 08:30 su2
-rwsr-xr-x 1 student student    0 Nov 10 08:30 suid
drwxrwxrwt 2 student student 4096 Nov 10 08:30 tw
$ ls -lF
total 20
-rwx--x--x 1 student student    0 Nov 10 08:30 exe*
-rw-r--r-- 1 student student    0 Nov 10 08:30 f
d--------- 2 student student 4096 Nov 10 08:30 locked/
drw-r--r-- 2 student student 4096 Nov 10 08:30 noexec/
drwxrwxrwx 2 student student 4096 Nov 10 08:30 ow/
-rw-r-Sr-- 1 student student    0 Nov 10 08:30 sg2
-rwxr-sr-x 1 student student    0 Nov 10 08:30 sgid*
-rw-r--r-T 1 student student    0 Nov 10 08:30 st2
drwxr-xr-t 2 student student 4096 Nov 10 08:30 sticky/
-rwSr--r-- 1 student student    0 Nov 10 08:30 su2
-rwsr-xr-x 1 student student    0 Nov 10 08:30 suid*
drwxrwxrwt 2 student student 4096 Nov 10 08:30 tw/
$ ls -F
exe*  f  locked/  noexec/  ow/	sg2  sgid*  st2  sticky/  su2  suid*  tw/
$ ls -p
exe  f	locked/  noexec/  ow/  sg2  sgid  st2  sticky/	su2  suid  tw/
$ ls locked
ls: cannot open directory 'locked': Permission denied
[exit 2]
$ ls -l locked f
-rw-r--r-- 1 student student    0 Nov 10 08:30 f

ls: cannot open directory 'locked': Permission denied
[exit 2]
$ ls noexec
inner
$ ls -l noexec
ls: cannot access 'noexec/inner': Permission denied
total 0
-????????? ? ? ? ?            ? inner
[exit 1]
$ ls -ls noexec
ls: cannot access 'noexec/inner': Permission denied
total 0
? -????????? ? ? ? ?            ? inner
[exit 1]
$ ls -R
.:
exe  f	locked	noexec	ow  sg2  sgid  st2  sticky  su2  suid  tw
ls: cannot open directory './locked': Permission denied

./noexec:
inner

./ow:

./sticky:

./tw:
[exit 1]
$ ls -ld locked noexec
d--------- 2 student student 4096 Nov 10 08:30 locked
drw-r--r-- 2 student student 4096 Nov 10 08:30 noexec
$ ls -d locked noexec
locked	noexec
