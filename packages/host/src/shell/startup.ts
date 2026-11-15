// TEMPORARY SHORTCUT (STATUS.md, removed by phase 22a): a login shell does not read its startup
// files yet, but the learner should see the prompt a real Ubuntu login shows. This sets PS1 to
// the value Ubuntu's ~/.bashrc would leave, when ~/.profile and ~/.bashrc are the files the
// system installed: /etc/skel's for a user, /root's for root. An edited ~/.bashrc is not run, so
// it leaves bash's default prompt instead of guessing.
//   reference: /etc/skel/.bashrc and /root/.bashrc of Ubuntu 24.04 (base/files.ts SKEL_BASHRC,
//   ROOT_BASHRC): the `color_prompt` test on $TERM, the two PS1 values and the xterm title prefix

import type { ProcApi } from '../proc/program.ts';
import { ROOT_BASHRC, SKEL_BASHRC } from '../base/files.ts';

const COLOR_PS1 = '${debian_chroot:+($debian_chroot)}\\[\\033[01;32m\\]\\u@\\h\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ ';
const PLAIN_PS1 = '${debian_chroot:+($debian_chroot)}\\u@\\h:\\w\\$ ';
const TITLE = '\\[\\e]0;${debian_chroot:+($debian_chroot)}\\u@\\h: \\w\\a\\]';

export function startupPrompt(p: ProcApi, home: string, term: string): string | undefined {
  let bashrc: string;
  try {
    p.fs().readFile(`${home}/.profile`);
    bashrc = p.fs().readFile(`${home}/.bashrc`);
  } catch {
    return undefined;
  }
  let color: boolean;
  if (bashrc === SKEL_BASHRC) color = term === 'xterm-color' || term.endsWith('-256color');
  else if (bashrc === ROOT_BASHRC) color = term === 'xterm-color';
  else return undefined;
  const ps1 = color ? COLOR_PS1 : PLAIN_PS1;
  return term.startsWith('xterm') || term.startsWith('rxvt') ? TITLE + ps1 : ps1;
}
