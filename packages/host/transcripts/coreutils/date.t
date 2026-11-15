# date: formats, -d strings on fixed dates (the current time differs between the capture and the
# simulator: see date.test.ts), -u, -R, -I, --rfc-3339, -r, -f, TZ, errors, setting the clock.
# tags: golden-verified
% touch -d '2026-11-10 08:30:00' f; printf '2026-01-01\nbad\n@0\n' > dates
$ date -d @1794816005
Mon Nov 16 08:00:05 UTC 2026
$ date -u -d @1794816005
Mon Nov 16 08:00:05 UTC 2026
$ date -d @1794816005 '+%c|%x|%X|%r|%p|%P|%Z|%z|%:z|%::z|%:::z|%N|%q|%C|%y|%g|%G|%V|%U|%W|%j|%k|%l|%e|%h'
Mon Nov 16 08:00:05 2026|11/16/26|08:00:05|08:00:05 AM|AM|am|UTC|+0000|+00:00|+00:00:00|+00|000000000|4|20|26|26|2026|47|46|46|320| 8| 8|16|Nov
$ date -d '2026-01-05 03:04:05' '+%-d|%_d|%0e|%-e|%_m|%10Y|%-10d|%_5H|%^a|%^B|%#Z|%#a|%#b|%Ey|%Od|%+4Y|%+6Y|%-j|%_j|%3d|%E|%O|%Q|%5|%-|x%'
5| 5|05|5| 1|0000002026|5|    3|MON|JANUARY|utc|MON|JAN|26|05|2026|+02026|5|  5|005|%E|%O|%Q|  %5|%-|x%
$ date -d '2026-01-05 13:04:05' '+%a %A %b %B %d %D %F %H %I %M %S %T %R %s %u %w %Y%n%t|%%|%10a|%-5A|'
Mon Monday Jan January 05 01/05/26 2026-01-05 13 01 04 05 13:04:05 13:04 1767618245 1 1 2026
	|%|       Mon|Monday|
$ date -d @0 +%s.%N; date -d @1.5 +%s.%N; date -d @-1.5 '+%F %T %s'
0.000000000
1.500000000
1969-12-31 23:59:58 -2
$ date -d '2027-01-01' '+%G-W%V-%u %U %W %j'; date -d '2026-12-31' '+%G-W%V-%u %U %W'; date -d '2021-01-03' '+%G %g %V %a'
2026-W53-5 00 00 001
2026-W53-4 52 52
2020 20 53 Sun
$ date -R -d @1794816005
Mon, 16 Nov 2026 08:00:05 +0000
$ date -I -d @1794816005; date -Ih -d @1794816005; date -Im -d @1794816005; date -Is -d @1794816005; date -Ins -d @1794816005
2026-11-16
2026-11-16T08+00:00
2026-11-16T08:00+00:00
2026-11-16T08:00:05+00:00
2026-11-16T08:00:05,000000000+00:00
$ date --iso-8601=hours -d @1794816005; date --iso=s -d @0
2026-11-16T08+00:00
1970-01-01T00:00:00+00:00
$ date --rfc-3339=date -d @1794816005; date --rfc-3339=seconds -d @1794816005; date --rfc-3339=ns -d @1794816005
2026-11-16
2026-11-16 08:00:05+00:00
2026-11-16 08:00:05.000000000+00:00
$ date -d '2026-03-04' '+%F %T'; date -d '2026-03-04 05:06' '+%F %T'; date -d '2026-03-04 05:06:07' '+%F %T'
2026-03-04 00:00:00
2026-03-04 05:06:00
2026-03-04 05:06:07
$ date -d '2026-03-04T05:06:07' '+%F %T'; date -d '2026-03-04T05:06:07Z' '+%F %T'; date -d '2026-03-04T05:06:07.123Z' '+%F %T.%3N'
2026-03-04 05:06:07
2026-03-04 05:06:07
2026-03-04 05:06:07.123
$ date -d '2026-03-04T05:06:07+02:00' '+%F %T'; date -d '2026-03-04 05:06:07 +0200' '+%F %T'; date -d '2026-03-04 05:06:07+0530' '+%F %T'
2026-03-04 03:06:07
2026-03-04 03:06:07
2026-03-03 23:36:07
$ date -d '2026-03-04 05:06:07 -0800' '+%F %T'; date -d '2026-03-04 05:06 +5' '+%F %T'; date -d '2026-03-04 UTC+2' '+%F %T'
2026-03-04 13:06:07
2026-03-04 00:06:00
2026-03-03 22:00:00
$ date -d '2026-3-4' +%F; date -d 20260304 +%F; date -d 2026/03/04 +%F; date -d 03/04/2026 +%F; date -d 99-03-04 +%F; date -d 69-03-04 +%F
2026-03-04
2026-03-04
2026-03-04
2026-03-04
1999-03-04
1969-03-04
$ date -d 'Mar 4 2026' +%F; date -d '4 Mar 2026' +%F; date -d 'March 4, 2026' +%F; date -d '  2026-03-04  ' +%F
2026-03-04
2026-03-04
2026-03-04
2026-03-04
$ date -d '2026-03-04 5' '+%F %T'; date -d '2026-03-04 0506' '+%F %T'; date -d '2026-03-04 2027' '+%F %T'
2026-03-04 05:00:00
2026-03-04 05:06:00
2026-03-04 20:27:00
$ date -d '2026-03-04 3pm' +%T; date -d '2026-03-04 5:06pm' +%T; date -d '2026-03-04 12am' +%T; date -d '2026-03-04 12:30 pm' +%T
15:00:00
17:06:00
00:00:00
12:30:00
$ date -d '2026-03-04 05:06 UTC' '+%F %T'; date -d '2026-03-04 05:06:07 Z' +%T; date -d '2026-03-04 gmt' '+%F %T'; date -d '1970-01-01 00:00:00 UTC' +%s
2026-03-04 05:06:00
05:06:07
2026-03-04 00:00:00
0
$ date -d '2026-03-04 +1 day' +%F; date -d '2026-01-31 1 month' +%F; date -d '2024-02-29 1 year' +%F; date -d '2026-03-04 1 fortnight' +%F
2026-03-05
2026-03-03
2025-03-01
2026-03-18
$ date -d '2026-03-04 next day' +%F; date -d '2026-03-04 last week' +%F; date -d '2026-03-04 05:00 1 hour ago' '+%F %T'
2026-03-05
2026-02-25
2026-03-04 04:00:00
$ date -d '2026-03-04 2 secs' +%T; date -d '2026-03-04 2 mins' +%T; date -d '2026-03-04 +2 weeks ago' +%F; date -d '2026-03-04 1 week 2 days' +%F
00:00:02
00:02:00
2026-02-18
2026-03-13
$ date -d '2026-03-04 05:06:07.999999999999' +%T; date -d 0000-01-01 +%F
05:06:07
0000-01-01
$ date -r f; date -r f +%s; date -u -r f -R
Tue Nov 10 08:30:00 UTC 2026
1794299400
Tue, 10 Nov 2026 08:30:00 +0000
$ date -f dates; echo $?
Thu Jan  1 00:00:00 UTC 2026
date: invalid date ‘bad’
Thu Jan  1 00:00:00 UTC 1970
1
$ date -f dates +%s
1767225600
date: invalid date ‘bad’
0
[exit 1]
$ date -f - +%F <<< '2026-07-04 10:00'
2026-07-04
$ date -f nope
date: nope: No such file or directory
[exit 1]
$ TZ=UTC date -d @0; TZ= date -d @0; TZ=UTC0 date -d @0 +%Z; TZ=Etc/UTC date -d @0 +%Z; TZ=GMT date -d @0; TZ=GMT0 date -u -d @0 +%Z
Thu Jan  1 00:00:00 UTC 1970
Thu Jan  1 00:00:00 UTC 1970
UTC
UTC
Thu Jan  1 00:00:00 GMT 1970
UTC
$ date -d '2026-13-01'
date: invalid date ‘2026-13-01’
[exit 1]
$ date -d '2026-02-30'
date: invalid date ‘2026-02-30’
[exit 1]
$ date -d '2026-03-04 25:00'
date: invalid date ‘2026-03-04 25:00’
[exit 1]
$ date -d '2026-03-04 05:06:60'
date: invalid date ‘2026-03-04 05:06:60’
[exit 1]
$ date -d '2026-03-04 13:00 pm'
date: invalid date ‘2026-03-04 13:00 pm’
[exit 1]
$ date -d @
date: invalid date ‘@’
[exit 1]
$ date -d @5x
date: invalid date ‘@5x’
[exit 1]
$ date -d '2026-03-04T'
date: invalid date ‘2026-03-04T’
[exit 1]
$ date -d '2026-03-04T05'
date: invalid date ‘2026-03-04T05’
[exit 1]
$ date -d '2026-03-04 foo'
date: invalid date ‘2026-03-04 foo’
[exit 1]
$ date -d '2026-03-04 -1'
date: invalid date ‘2026-03-04 -1’
[exit 1]
$ date -d '2026-03-04 +0130'
date: invalid date ‘2026-03-04 +0130’
[exit 1]
$ date -d '2026-03-04 1 hrs'
date: invalid date ‘2026-03-04 1 hrs’
[exit 1]
$ date -d '2026-03-04 ago'
date: invalid date ‘2026-03-04 ago’
[exit 1]
$ date -d '2026-03-04 123456'
date: invalid date ‘2026-03-04 123456’
[exit 1]
$ date -d foo
date: invalid date ‘foo’
[exit 1]
$ date -r nope
date: nope: No such file or directory
[exit 1]
$ date -r f -d @0
date: the options to specify dates for printing are mutually exclusive
Try 'date --help' for more information.
[exit 1]
$ date -d @0 -d @5
Thu Jan  1 00:00:05 UTC 1970
$ date -d @0 +%s +%s
date: extra operand ‘+%s’
Try 'date --help' for more information.
[exit 1]
$ date -d @0 x
date: the argument ‘x’ lacks a leading '+';
when using an option to specify date(s), any non-option
argument must be a format string beginning with '+'
Try 'date --help' for more information.
[exit 1]
$ date -d @0 -R +%s
date: multiple output formats specified
[exit 1]
$ date -R -I -d @0
date: multiple output formats specified
[exit 1]
$ date -Ix -d @0
date: invalid argument ‘x’ for ‘--iso-8601’
Valid arguments are:
  - ‘hours’
  - ‘minutes’
  - ‘date’
  - ‘seconds’
  - ‘ns’
Try 'date --help' for more information.
[exit 1]
$ date --iso-8601= -d @0
date: ambiguous argument ‘’ for ‘--iso-8601’
Valid arguments are:
  - ‘hours’
  - ‘minutes’
  - ‘date’
  - ‘seconds’
  - ‘ns’
Try 'date --help' for more information.
[exit 1]
$ date --rfc-3339 -d @0
date: invalid argument ‘-d’ for ‘--rfc-3339’
Valid arguments are:
  - ‘date’
  - ‘seconds’
  - ‘ns’
Try 'date --help' for more information.
[exit 1]
$ date --rfc-3339=x -d @0
date: invalid argument ‘x’ for ‘--rfc-3339’
Valid arguments are:
  - ‘date’
  - ‘seconds’
  - ‘ns’
Try 'date --help' for more information.
[exit 1]
$ date -d
date: option requires an argument -- 'd'
Try 'date --help' for more information.
[exit 1]
$ date --bogus
date: unrecognized option '--bogus'
Try 'date --help' for more information.
[exit 1]
$ date -s @0; echo $?
date: cannot set date: Operation not permitted
Thu Jan  1 00:00:00 UTC 1970
1
$ date -u 0101000027.30; echo $?
date: cannot set date: Operation not permitted
Fri Jan  1 00:00:30 UTC 2027
1
$ date 01010000; echo $?
date: cannot set date: Operation not permitted
Thu Jan  1 00:00:00 UTC 2026
1
$ date 0101
date: invalid date ‘0101’
[exit 1]
$ date 13010000
date: invalid date ‘13010000’
[exit 1]
$ date 01010000.
date: invalid date ‘01010000.’
[exit 1]
$ date 02300000
date: invalid date ‘02300000’
[exit 1]
$ date -s foo
date: invalid date ‘foo’
[exit 1]
$ date -s @0 -d @0
date: the options to print and set the time may not be used together
Try 'date --help' for more information.
[exit 1]
$ date --help | head -2
Usage: date [OPTION]... [+FORMAT]
  or:  date [-u|--utc|--universal] [MMDDhhmm[[CC]YY][.ss]]
