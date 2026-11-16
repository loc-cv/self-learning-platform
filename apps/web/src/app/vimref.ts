// What the real vim shows on its message line, for the editor overlay (DIV-014: the overlay is
// not a terminal vim, but where it says something vim says, it says it in vim's words).
//   reference: vim 9.1 (patches 1-16), captured 2026-11-16 by fixtures/reference/vim/messages.py;
//   vimref.test.ts checks every string here against fixtures/reference/vim/messages.json.

/** The file information vim shows when a buffer opens and after a write: `"f.yaml" 2L, 10B`. */
export function fileInfo(name: string, text: string, flags: { isNew?: boolean; readOnly?: boolean } = {}): string {
  if (flags.isNew) return `"${name}" [New]`;
  const noeol = text !== '' && !text.endsWith('\n');
  const lines = text === '' ? 0 : text.split('\n').length - (noeol ? 0 : 1);
  const tags = `${flags.readOnly ? ' [readonly]' : ''}${noeol ? ' [noeol]' : ''}`;
  return `"${name}"${tags} ${lines}L, ${new TextEncoder().encode(text).length}B`;
}

/** After `:w`: `"f.yaml" 2L, 9B written`, with `[New]` on the first write of a new file. */
export function written(name: string, text: string, wasNew: boolean): string {
  const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  return `"${name}"${wasNew ? ' [New]' : ''} ${lines}L, ${new TextEncoder().encode(text).length}B written`;
}

export const E37 = "E37: No write since last change (add ! to override)";
export const E45 = "E45: 'readonly' option is set (add ! to override)";
export const E492 = (command: string): string => `E492: Not an editor command: ${command}`;

/** The mode line for the overlay's vim modes, keyed by the vim emulation's mode names. */
export const MODES: Record<string, string> = {
  insert: "-- INSERT --",
  replace: "-- REPLACE --",
  visual: "-- VISUAL --",
  'visual-linewise': "-- VISUAL LINE --",
  'visual-blockwise': "-- VISUAL BLOCK --",
};

/** Every Ex command name of vim 9.1: getcompletion('', 'command'). */
export const EX_COMMANDS: readonly string[] = [
  "!", "#", "&", "*", "++", "--", "<", "=", ">", "@", "Next", "Print", "X", "abbreviate",
  "abclear", "aboveleft", "abstract", "all", "amenu", "anoremenu", "append", "argadd", "argdedupe",
  "argdelete", "argdo", "argedit", "argglobal", "arglocal", "args", "argument", "ascii", "augroup",
  "aunmenu", "autocmd", "bNext", "badd", "ball", "balt", "bdelete", "behave", "belowright",
  "bfirst", "blast", "bmodified", "bnext", "botright", "bprevious", "break", "breakadd",
  "breakdel", "breaklist", "brewind", "browse", "bufdo", "buffer", "buffers", "bunload",
  "bwipeout", "cNext", "cNfile", "cabbrev", "cabclear", "cabove", "caddbuffer", "caddexpr",
  "caddfile", "cafter", "call", "catch", "cbefore", "cbelow", "cbottom", "cbuffer", "cc", "cclose",
  "cd", "cdo", "center", "cexpr", "cfdo", "cfile", "cfirst", "cgetbuffer", "cgetexpr", "cgetfile",
  "change", "changes", "chdir", "checkpath", "checktime", "chistory", "class", "clast",
  "clearjumps", "clist", "close", "cmap", "cmapclear", "cmenu", "cnewer", "cnext", "cnfile",
  "cnoreabbrev", "cnoremap", "cnoremenu", "colder", "colorscheme", "comclear", "command",
  "compiler", "confirm", "const", "continue", "copen", "copy", "cpfile", "cprevious", "cquit",
  "crewind", "cscope", "cstag", "cunabbrev", "cunmap", "cunmenu", "cwindow", "debug",
  "debuggreedy", "def", "defcompile", "defer", "delcommand", "delete", "delfunction", "delmarks",
  "diffget", "diffoff", "diffpatch", "diffput", "diffsplit", "diffthis", "diffupdate", "digraphs",
  "disassemble", "display", "djump", "dlist", "doautoall", "doautocmd", "drop", "dsearch",
  "dsplit", "earlier", "echo", "echoconsole", "echoerr", "echohl", "echomsg", "echon",
  "echowindow", "edit", "else", "elseif", "emenu", "endclass", "enddef", "endenum", "endfor",
  "endfunction", "endif", "endinterface", "endtry", "endwhile", "enew", "enum", "eval", "ex",
  "execute", "exit", "export", "exusage", "file", "files", "filetype", "filter", "final",
  "finally", "find", "finish", "first", "fixdel", "fold", "foldclose", "folddoclosed",
  "folddoopen", "foldopen", "for", "function", "global", "goto", "grep", "grepadd", "gui", "gvim",
  "hardcopy", "help", "helpclose", "helpfind", "helpgrep", "helptags", "hide", "highlight",
  "history", "horizontal", "iabbrev", "iabclear", "if", "ijump", "ilist", "imap", "imapclear",
  "imenu", "import", "inoreabbrev", "inoremap", "inoremenu", "insert", "interface", "intro",
  "isearch", "isplit", "iunabbrev", "iunmap", "iunmenu", "join", "jumps", "k", "keepalt",
  "keepjumps", "keepmarks", "keeppatterns", "lNext", "lNfile", "labove", "laddbuffer", "laddexpr",
  "laddfile", "lafter", "language", "last", "later", "lbefore", "lbelow", "lbottom", "lbuffer",
  "lcd", "lchdir", "lclose", "lcscope", "ldo", "left", "leftabove", "legacy", "let", "lexpr",
  "lfdo", "lfile", "lfirst", "lgetbuffer", "lgetexpr", "lgetfile", "lgrep", "lgrepadd",
  "lhelpgrep", "lhistory", "list", "ll", "llast", "llist", "lmake", "lmap", "lmapclear", "lnewer",
  "lnext", "lnfile", "lnoremap", "loadkeymap", "loadview", "lockmarks", "lockvar", "lolder",
  "lopen", "lpfile", "lprevious", "lrewind", "ls", "ltag", "lua", "luado", "luafile", "lunmap",
  "lvimgrep", "lvimgrepadd", "lwindow", "make", "map", "mapclear", "mark", "marks", "match",
  "menu", "menutranslate", "messages", "mkexrc", "mksession", "mkspell", "mkview", "mkvimrc",
  "mode", "move", "mzfile", "mzscheme", "nbclose", "nbkey", "nbstart", "new", "next", "nmap",
  "nmapclear", "nmenu", "nnoremap", "nnoremenu", "noautocmd", "nohlsearch", "noreabbrev",
  "noremap", "noremenu", "normal", "noswapfile", "number", "nunmap", "nunmenu", "oldfiles", "omap",
  "omapclear", "omenu", "only", "onoremap", "onoremenu", "open", "options", "ounmap", "ounmenu",
  "ownsyntax", "packadd", "packloadall", "pclose", "pedit", "perl", "perldo", "pop", "popup",
  "ppop", "preserve", "previous", "print", "profdel", "profile", "promptfind", "promptrepl",
  "psearch", "ptNext", "ptag", "ptfirst", "ptjump", "ptlast", "ptnext", "ptprevious", "ptrewind",
  "ptselect", "public", "put", "pwd", "py3", "py3do", "py3file", "pydo", "pyfile", "python",
  "python3", "pythonx", "pyx", "pyxdo", "pyxfile", "qall", "quit", "quitall", "read", "recover",
  "redir", "redo", "redraw", "redrawstatus", "redrawtabline", "registers", "resize", "retab",
  "return", "rewind", "right", "rightbelow", "ruby", "rubydo", "rubyfile", "rundo", "runtime",
  "rviminfo", "sNext", "sall", "sandbox", "sargument", "saveas", "sbNext", "sball", "sbfirst",
  "sblast", "sbmodified", "sbnext", "sbprevious", "sbrewind", "sbuffer", "scriptencoding",
  "scriptnames", "scriptversion", "scscope", "set", "setfiletype", "setglobal", "setlocal",
  "sfind", "sfirst", "shell", "sign", "silent", "simalt", "slast", "sleep", "smagic", "smap",
  "smapclear", "smenu", "smile", "snext", "snomagic", "snoremap", "snoremenu", "sort", "source",
  "spelldump", "spellgood", "spellinfo", "spellrare", "spellrepall", "spellundo", "spellwrong",
  "split", "sprevious", "srewind", "stag", "startgreplace", "startinsert", "startreplace",
  "static", "stjump", "stop", "stopinsert", "stselect", "substitute", "sunhide", "sunmap",
  "sunmenu", "suspend", "sview", "swapname", "syncbind", "syntax", "syntime", "t", "tNext", "tab",
  "tabNext", "tabclose", "tabdo", "tabedit", "tabfind", "tabfirst", "tablast", "tabmove", "tabnew",
  "tabnext", "tabonly", "tabprevious", "tabrewind", "tabs", "tag", "tags", "tcd", "tchdir", "tcl",
  "tcldo", "tclfile", "tearoff", "terminal", "tfirst", "this", "throw", "tjump", "tlast", "tlmenu",
  "tlnoremenu", "tlunmenu", "tmap", "tmapclear", "tmenu", "tnext", "tnoremap", "topleft",
  "tprevious", "trewind", "try", "tselect", "tunmap", "tunmenu", "type", "unabbreviate", "undo",
  "undojoin", "undolist", "unhide", "unlet", "unlockvar", "unmap", "unmenu", "unsilent", "update",
  "var", "verbose", "version", "vertical", "vglobal", "view", "vim9cmd", "vim9script", "vimgrep",
  "vimgrepadd", "visual", "viusage", "vmap", "vmapclear", "vmenu", "vnew", "vnoremap", "vnoremenu",
  "vsplit", "vunmap", "vunmenu", "wNext", "wall", "while", "wincmd", "windo", "winpos", "winsize",
  "wnext", "wprevious", "wq", "wqall", "write", "wundo", "wviminfo", "xall", "xit", "xmap",
  "xmapclear", "xmenu", "xnoremap", "xnoremenu", "xrestore", "xunmap", "xunmenu", "yank", "z", "{",
  "}", "~",
];

/** True when vim would take `name` (as typed after `:`) for one of its commands: a full name or a prefix of one. */
export function isVimCommand(name: string): boolean {
  return name !== '' && EX_COMMANDS.some((c) => c.startsWith(name));
}
