# sleep: intervals with suffixes and fractions, sums, invalid intervals, usage errors.
# tags: golden-verified
$ sleep 0.1; echo $?
0
$ sleep .05 0.05s 1e-2 0x0.1 " 0.01"; echo $?
0
$ sleep 0m 0h 0d +0; echo $?
0
$ sleep
sleep: missing operand
Try 'sleep --help' for more information.
[exit 1]
$ sleep 1x
sleep: invalid time interval ‘1x’
Try 'sleep --help' for more information.
[exit 1]
$ sleep 1ss 2 a ""
sleep: invalid time interval ‘1ss’
sleep: invalid time interval ‘a’
sleep: invalid time interval ‘’
Try 'sleep --help' for more information.
[exit 1]
$ sleep -1
sleep: invalid option -- '1'
Try 'sleep --help' for more information.
[exit 1]
$ sleep -- -1
sleep: invalid time interval ‘-1’
Try 'sleep --help' for more information.
[exit 1]
$ sleep 0,5
sleep: invalid time interval ‘0,5’
Try 'sleep --help' for more information.
[exit 1]
$ sleep nan
sleep: invalid time interval ‘nan’
Try 'sleep --help' for more information.
[exit 1]
$ sleep --bogus
sleep: unrecognized option '--bogus'
Try 'sleep --help' for more information.
[exit 1]
$ sleep 0.1 --help | head -4
Usage: sleep NUMBER[SUFFIX]...
  or:  sleep OPTION
Pause for NUMBER seconds.  SUFFIX may be 's' for seconds (the default),
'm' for minutes, 'h' for hours or 'd' for days.  NUMBER need not be an
