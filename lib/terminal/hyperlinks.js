// OSC 8 hyperlinks, from a program in a pane to the terminal in the browser.
//
// A program that marks its links itself names the target on every cell of
// them, so such a link survives however the program wrapped its text. The
// browser's own detection (plugins/files/client/js/file-preview.js) can only
// guess at that. Two things stand between the program and xterm.js:
//
//  - tmux forwards hyperlinks only to clients whose terminal has the
//    `hyperlinks` feature. It tells terminals apart by the name they answer
//    with (tty-keys.c), does not know xterm.js, and TERM=xterm-256color alone
//    does not carry the feature. The panel's own clients therefore declare it
//    with -T; no other client and no server option changes.
//  - A program decides from its environment whether to emit them. Inside tmux
//    Claude Code wants TERM_PROGRAM_VERSION >= 3.4, and the managed tmux, a
//    development build, says `next-3.8` (docs/known-issues.md ENV-14).
//    FORCE_HYPERLINK is the switch these programs share.

/** tmux global options that declare the feature for one client. */
export const HYPERLINK_CLIENT_ARGS = Object.freeze(['-T', 'hyperlinks']);

/**
 * The same, for a tmux of a known version. -T exists since 3.2 and an older
 * tmux refuses to start with it, so without a version nothing is added; the
 * feature itself came with 3.4.
 * @param {string | null | undefined} version as `tmux -V` gives it: "3.4", "3.5a", "next-3.8"
 */
export function hyperlinkClientArgs(version) {
  const match = /(\d+)\.(\d+)/.exec(String(version || ''));
  if (!match) return [];
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 3 || (major === 3 && minor >= 4) ? [...HYPERLINK_CLIENT_ARGS] : [];
}

/**
 * One tmux command that puts FORCE_HYPERLINK=1 into the global environment,
 * which new panes start from, unless it is already set. A value somebody
 * chose stays, `0` included: that is how to turn this off.
 */
export const HYPERLINK_ENV_COMMAND = Object.freeze([
  'if-shell', '-F', '#{!=:#{FORCE_HYPERLINK},}', '', 'set-environment -g FORCE_HYPERLINK 1',
]);
