import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';

// Load the DOM-free cores into a sandbox. file-preview.js references LinkDetect
// as a bare global and exposes a _test seam for the buffer-level logic.
let FP;
let W;
beforeAll(() => {
  const w = {};
  new Function('window', fs.readFileSync('plugins/terminal/client/js/link-detect.js', 'utf8'))(w);
  globalThis.LinkDetect = w.LinkDetect;
  new Function('window', fs.readFileSync('plugins/files/client/js/file-preview.js', 'utf8'))(w);
  FP = w.FilePreview._test;
  W = w;
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

// A buffer with real cell widths: CJK takes two columns (the second cell is
// empty with width 0), a glyph outside the BMP is two string characters in one.
const isWide = (ch) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠￠-￦]/.test(ch);
function mkCells(rows, cols) {
  const lines = rows.map((r) => {
    const cells = [];
    for (const ch of r.text) {
      cells.push({ ch, w: isWide(ch) ? 2 : 1 });
      if (isWide(ch)) cells.push({ ch: '', w: 0 });
    }
    while (cells.length < cols) cells.push({ ch: '', w: 1 });
    return {
      isWrapped: !!r.wrapped,
      length: cols,
      // Like xterm's: optionally only the cells from `start` up to `end`.
      translateToString(trim, start = 0, end = cols) {
        const s = cells.slice(start, Math.min(end, cols)).map((c) => (c.w === 0 ? '' : c.ch || ' ')).join('');
        return trim ? s.replace(/\s+$/, '') : s;
      },
      getCell(col) {
        const c = cells[col];
        return c ? { getWidth: () => c.w, getChars: () => c.ch } : undefined;
      },
    };
  });
  return { length: lines.length, viewportY: 0, getLine: (i) => lines[i] || null };
}
// The links each row resolves to, by their text. `settled`: the machine has
// been asked, so a path still unknown is one nobody can vouch for.
const linkTexts = (buf, lookup, settled = false) => Array.from({ length: buf.length }, (_, row) =>
  FP.findLinks(FP.linkLine(buf, row, lookup, settled).logical.text).map((m) => m.text));
const unknown = () => undefined;

// Minimal xterm-buffer mock: fixed width, ASCII cells (width 1).
function mkBuffer(rows, cols) {
  const lines = rows.map((r) => ({
    isWrapped: !!r.wrapped,
    length: cols,
    translateToString(trim, start = 0, end = cols) {
      const padded = (r.text + ' '.repeat(cols)).slice(0, cols).slice(start, end);
      return trim ? padded.replace(/\s+$/, '') : padded;
    },
    getCell(col) {
      const ch = col < r.text.length ? r.text[col] : ' ';
      return { getWidth: () => 1, getChars: () => ch };
    },
  }));
  return { length: lines.length, getLine: (i) => lines[i] || null };
}

describe('F1 — wrapped-row end offset stays on the correct row', () => {
  it('a link ending exactly at the row boundary does not bleed onto the next row', () => {
    const cols = 8;
    const buf = mkBuffer([
      { text: 'x/aa/bbb' },               // full row, link fills it
      { text: ' next', wrapped: true },   // soft-wrap continuation (leading space)
    ], cols);
    const logical = FP.getLogicalLine(buf, 0);
    const links = FP.findLinks(logical.text);
    const path = links.find((m) => m.text === 'x/aa/bbb');
    expect(path, 'path should be detected').toBeTruthy();
    const range = FP.buildLinkRange(logical, path);
    expect(range.start).toEqual({ y: 1, x: 1 });
    expect(range.end.y).toBe(1);   // NOT row 2
    expect(range.end.x).toBe(8);
  });
});

describe('F3 — hard-newline continuation resolves to the joined line', () => {
  const cols = 28;
  const buf = () => mkBuffer([
    { text: 'https://example.com/a/b/c/d/' },  // full, ends with an open token
    { text: 'h/i.html' },                       // hard newline (not wrapped)
  ], cols);

  it('forward: row 0 merges the hard-split URL', () => {
    const l = FP.getLogicalLine(buf(), 0);
    expect(l.startRow).toBe(0);
    expect(FP.findLinks(l.text).some((m) => m.kind === 'web' && m.text.includes('h/i.html'))).toBe(true);
  });

  it('continuation row 1 resolves back to row 0 (no wrong standalone fragment)', () => {
    const l = FP.getLogicalLine(buf(), 1);
    expect(l.startRow).toBe(0);
    const links = FP.findLinks(l.text);
    expect(links.some((m) => m.kind === 'web')).toBe(true);
    expect(links.some((m) => m.kind === 'file' && m.text === 'h/i.html')).toBe(false);
  });

  it('does NOT join when the next row is indented', () => {
    const b = mkBuffer([
      { text: 'https://example.com/a/b/c/d/' },
      { text: '    indented' },
    ], cols);
    expect(FP.getLogicalLine(b, 0).rows.length).toBe(1);
  });
});

describe('F4 — hanging-indent hard wrap stays one file link', () => {
  const first = '  Documents/Obsidian_document/DataAnt/三绿/DataAnt-Android14-';
  const second = '  property_service-Wuying属性重写问题说明.md';
  const fullPath = first.slice(2) + second.slice(2);
  // Codex-like TUI wraps to a content width narrower than the xterm row, so
  // the first physical row still has visible blank cells on the right.
  const cols = first.length + 12;
  const buf = () => mkBuffer([
    { text: first },
    { text: second },
  ], cols);

  it('joins a continuation aligned with the path start column', () => {
    const logical = FP.getLogicalLine(buf(), 1);
    expect(logical.startRow).toBe(0);
    expect(logical.text.trimEnd()).toBe('  ' + fullPath);
    const links = FP.findLinks(logical.text);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe(fullPath);
  });

  it('maps the joined continuation back to its indented terminal columns', () => {
    const logical = FP.getLogicalLine(buf(), 0);
    const link = FP.findLinks(logical.text)[0];
    const range = FP.buildLinkRange(logical, link);
    expect(range.start).toEqual({ y: 1, x: 3 });
    expect(range.end).toEqual({ y: 2, x: second.length });
  });

  it('does not clamp a short continuation to the first row start column', () => {
    const shortFirst = '      abc/defghijklmnopqrstuv-';
    const shortSecond = '      x';
    const shortBuf = mkBuffer([
      { text: shortFirst },
      { text: shortSecond },
    ], shortFirst.length);
    const logical = FP.getLogicalLine(shortBuf, 0);
    const link = FP.findLinks(logical.text)[0];
    const range = FP.buildLinkRange(logical, link);
    expect(range.end).toEqual({ y: 2, x: shortSecond.length });
  });

  it('does not join when the continuation indentation differs', () => {
    const mismatch = mkBuffer([
      { text: first },
      { text: '    property_service-Wuying属性重写问题说明.md' },
    ], cols);
    expect(FP.getLogicalLine(mismatch, 0).rows).toHaveLength(1);
  });
});

// --- Rows a program wrapped by itself -------------------------------------
//
// A TUI writes each row of its own wrapping separately, with an indent or a
// box edge before the continuation; nothing marks the rows as one line.

describe('a token a TUI broke where its row was full', () => {
  // Claude Code: text from column 2, four columns kept free on the right, and
  // Chinese without spaces is one word that breaks wherever the row ends.
  const PATH = 'plugins/terminal/client/js/link-detect.js';
  const claude = () => mkCells([
    { text: '● 我已经修改了plugins/terminal/client/js/link-d' },
    { text: '  etect.js里的正则，现在可以了' },
  ], 50);

  it('is one link from either row: confirmed by the machine, or by its looks when nothing is', () => {
    const buf = claude();
    // Not asked yet: as the strict rules have it, and it says what to ask.
    expect(linkTexts(buf, unknown)).toEqual([['plugins/terminal/client/js/link-d'], ['etect.js']]);
    expect(FP.linkLine(buf, 0, unknown, false).pending).toEqual([PATH, 'plugins/terminal/client/js/link-d', 'etect.js']);
    // The joined path exists.
    expect(linkTexts(buf, (path) => path === PATH)).toEqual([[PATH], [PATH]]);
    // Asked, and nobody can say (an older Node, a dead link): the seam's looks decide.
    expect(linkTexts(buf, unknown, true)).toEqual([[PATH], [PATH]]);
    // Neither the path nor either half exists: a file not written yet reads the same way.
    expect(linkTexts(buf, () => false)).toEqual([[PATH], [PATH]]);
  });

  it('stays two rows when one of them names a file by itself, however full the row looks', () => {
    // A narrow terminal: the path ends four columns from the margin and is the
    // longest row around, exactly what a broken token looks like.
    const ALONE = 'plugins/files/client/js/file-preview.js';
    const buf = mkCells([
      { text: '● Updated the file at' },
      { text: '  ' + ALONE },
      { text: '  and ran the tests.' },
    ], 46);
    expect(FP.linkLine(buf, 1, unknown, false).pending).toEqual([ALONE + 'and', ALONE]);
    // Joining would take away a link that works.
    expect(linkTexts(buf, (path) => path === ALONE)[1]).toEqual([ALONE]);
  });

  it('is underlined on its own cells: after the wide glyphs, without the indent', () => {
    const logical = FP.linkLine(claude(), 1, unknown, true).logical;
    const range = FP.buildLinkRange(logical, FP.findLinks(logical.text)[0]);
    // ● and a space, six ideographs of two columns each: the path starts in column 15.
    expect(range.start).toEqual({ y: 1, x: 15 });
    // `etect.js` sits in columns 3-10 of the second row.
    expect(range.end).toEqual({ y: 2, x: 10 });
  });

  it('joins a URL without asking anybody, when what follows reads like the rest of it', () => {
    const URL = 'https://github.com/anthropics/claude-code/issues/12345';
    const buf = mkCells([
      { text: '● https://github.com/anthropics/claude-code/issu' },
      { text: '  es/12345 这个 issue' },
    ], 52);
    expect(linkTexts(buf, unknown)).toEqual([[URL], [URL]]);
    expect(FP.linkLine(buf, 0, unknown, false).pending).toEqual([]);
  });

  it('does not join a URL to the next word of a sentence on a margin it only estimates', () => {
    // Four columns from the terminal's edge, the longest row around - and complete.
    const buf = mkCells([
      { text: '● Docs:' },
      { text: '  https://docs.example.com/guide/getting-started' },
      { text: '  for details on setup.' },
    ], 52);
    expect(linkTexts(buf, unknown)[1]).toEqual(['https://docs.example.com/guide/getting-started']);
  });

  it('follows a link over more than two rows, whichever row is asked', () => {
    const URL = 'https://example.com/aaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbb/ccc.html';
    const buf = mkCells([
      { text: 'https://example.com/aaaaaaaaa/' },
      { text: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbb/' },
      { text: 'ccc.html' },
    ], 30);
    expect(linkTexts(buf, unknown)).toEqual([[URL], [URL], [URL]]);
  });

  it('reads through a box: the edges and their padding are not part of the path', () => {
    const buf = mkCells([
      { text: '│ see /very/long/path/to/some/fi │' },
      { text: '│ le.txt for details             │' },
    ], 34);
    expect(linkTexts(buf, unknown, true)).toEqual([['/very/long/path/to/some/file.txt'], ['/very/long/path/to/some/file.txt']]);
    const logical = FP.linkLine(buf, 0, unknown, true).logical;
    const range = FP.buildLinkRange(logical, FP.findLinks(logical.text)[0]);
    expect(range.start).toEqual({ y: 1, x: 7 });
    expect(range.end).toEqual({ y: 2, x: 8 });
  });
});

describe('a path a TUI broke where it may break one', () => {
  // Codex wraps with textwrap on Unicode line breaking: a path breaks after a
  // `/` or a hyphen, and the row ends there, short of the margin, because the
  // next piece no longer fitted. "• " first, then a two-column hanging indent.
  const FIRST = 'plugins/files/client/js/file-preview.js';
  const SECOND = 'test/client/file-preview-links.test.js';
  const codex = () => mkCells([
    { text: '• I updated the link provider in plugins/files/client/js/' },
    { text: '  file-preview.js:5218 and added tests in test/client/file-' },
    { text: '  preview-links.test.js so that wrapped paths keep working.' },
  ], 60);

  it('is one link from every row although none is full, with or without the machine\'s word', () => {
    const buf = codex();
    // Not asked yet: the rows as they are, and what to ask.
    expect(linkTexts(buf, unknown)).toEqual([
      ['plugins/files/client/js/'], ['file-preview.js', 'test/client/file-'], ['preview-links.test.js']]);
    expect(FP.linkLine(buf, 1, unknown, false).pending).toEqual([
      FIRST, 'plugins/files/client/js/', 'file-preview.js', SECOND, 'test/client/file-', 'preview-links.test.js']);
    // An older Node, a path the panel may not read: nobody can say.
    expect(linkTexts(buf, unknown, true)).toEqual([[FIRST, SECOND], [FIRST, SECOND], [FIRST, SECOND]]);
    expect(linkTexts(buf, (path) => path === FIRST || path === SECOND))
      .toEqual([[FIRST, SECOND], [FIRST, SECOND], [FIRST, SECOND]]);
  });

  it('stays a directory when that is what the machine has', () => {
    expect(linkTexts(codex(), (path) => path === 'plugins/files/client/js/')[0]).toEqual(['plugins/files/client/js/']);
  });

  it('reads the target Codex prints in brackets after a link\'s label', () => {
    const buf = mkCells([
      { text: '• The seam rule is in file-preview.js (plugins/files/client/js/' },
      { text: '  file-preview.js:4811) and its tests are next to it.' },
    ], 64);
    expect(linkTexts(buf, unknown, true)).toEqual([['file-preview.js', FIRST], ['file-preview.js', FIRST]]);
  });

  it('reads through a tree prefix', () => {
    const joined = 'plugins/terminal/client/js/terminal-fonts-data.js';
    const buf = mkCells([
      { text: '• Edited 2 files' },
      { text: '  └ plugins/terminal/client/js/terminal-fonts-' },
      { text: '    data.js (+12 -3)' },
    ], 50);
    expect(linkTexts(buf, unknown, true)).toEqual([[], [joined], [joined]]);
  });

  it('takes a box\'s inner edge for the right edge', () => {
    const boxed = (first) => mkCells([
      { text: first },
      { text: '│ file-preview.js for the details'.padEnd(43) + '│' },
    ], 44);
    expect(linkTexts(boxed('│ see the code in plugins/files/client/js/ │'), unknown, true)).toEqual([[FIRST], [FIRST]]);
    // Twelve columns were left: a wrapper would have put `file-` there.
    expect(linkTexts(boxed('│ see plugins/files/client/js/             │'), unknown, true))
      .toEqual([['plugins/files/client/js/'], ['file-preview.js']]);
  });

  it('is not made of a directory and the next word of the sentence', () => {
    const buf = mkCells([
      { text: '• The screenshots are under ~/Documents/notes/2026/screens/' },
      { text: '  for later.' },
    ], 60);
    expect(linkTexts(buf, unknown, true)).toEqual([['~/Documents/notes/2026/screens/'], []]);
  });

  it('is left to the file system where the next piece would have fitted', () => {
    const buf = mkCells([
      { text: '$ ls plugins/files/client/js/' },
      { text: 'file-preview.js  other.js' },
    ], 80);
    expect(linkTexts(buf, unknown, true)).toEqual([['plugins/files/client/js/'], ['file-preview.js', 'other.js']]);
    expect(FP.linkLine(buf, 0, unknown, false).pending).toEqual([FIRST]);
  });

  it('does not continue a URL: one that ends in a slash is complete as often as not', () => {
    const buf = mkCells([
      { text: '• The documentation is hosted at https://example.com/docs/' },
      { text: '  getting-started.md is the first page to read.' },
    ], 60);
    expect(linkTexts(buf, unknown, true)).toEqual([['https://example.com/docs/'], ['getting-started.md']]);
    expect(FP.linkLine(buf, 0, unknown, false).pending).toEqual([]);
  });
});

describe('a split window', () => {
  // tmux draws every pane of the window on one screen: a row holds the left
  // pane, the border, the right pane. These rows are what a panel client of a
  // private tmux server received (two panes on the right, titles on top).
  const PREVIEW = 'plugins/files/client/js/file-preview.js';
  const TEST = 'test/client/file-preview-links.test.js';
  const NOTES = '~/Documents/notes/terminal-links-investigation.md';
  const URL = 'https://github.com/anthropics/claude-code/issues/12345/comments/67890';
  const panes = (rows, leftWidth, rightWidth) => mkCells(rows.map(([left, right, border = '│']) => (
    { text: left.padEnd(leftWidth) + border + right })), leftWidth + 1 + rightWidth);
  const window = () => panes([
    ['──· 0:sh '.padEnd(50, '─'), '──· 1:sh '.padEnd(49, '─'), '┬'],
    ['see plugins/files/client/js/file-preview.js:5218 a', '• Changed the code in plugins/files/client/js/'],
    ['nd the tests in test/client/file-preview-links.tes', '  file-preview.js and the tests.'],
    ['t.js too', 'and ~/Documents/notes/terminal-links-investigatio'],
    ['https://github.com/anthropics/claude-code/issues/1', 'n.md'],
    ['2345/comments/67890', ''],
  ], 50, 49);
  // The links on a row, with the cells each has there (from 1, both included).
  const rowLinks = (buf, row, lookup = unknown, settled = true) => {
    const out = [];
    for (const logical of FP.rowLinkLines(buf, row, lookup, settled).lines) {
      for (const m of FP.findLinks(logical.text)) {
        for (const r of FP.rowRanges(logical.rows, m) || [FP.buildLinkRange(logical, m)]) {
          if (r.start.y <= row + 1 && r.end.y >= row + 1) out.push(`${m.text} ${r.start.y}:${r.start.x}-${r.end.y}:${r.end.x}`);
        }
      }
    }
    return out;
  };

  it('reads each pane by itself, across the rows tmux broke at the pane\'s edge', () => {
    const buf = window();
    expect(rowLinks(buf, 0)).toEqual([]);
    expect(rowLinks(buf, 1)).toEqual([`${PREVIEW} 2:5-2:48`, `${PREVIEW} 2:74-2:97`]);
    expect(rowLinks(buf, 2)).toEqual([`${TEST} 3:17-3:50`, `${PREVIEW} 3:54-3:68`]);
    expect(rowLinks(buf, 3)).toEqual([`${TEST} 4:1-4:4`, `${NOTES} 4:56-4:100`]);
    expect(rowLinks(buf, 4)).toEqual([`${URL} 5:1-5:50`, `${NOTES} 5:52-5:55`]);
    expect(rowLinks(buf, 5)).toEqual([`${URL} 6:1-6:19`]);
  });

  it('asks about the paths of every pane on the row', () => {
    expect(FP.rowLinkLines(window(), 3, unknown, false).pending).toEqual([
      TEST, 'test/client/file-preview-links.tes', 't.js',
      NOTES, '~/Documents/notes/terminal-links-investigatio', 'n.md']);
  });

  it('follows a pane past the border between two panes beside it', () => {
    const LOG = '/var/log/anymux/terminal-gateway-2026-11-17.log';
    const buf = panes([
      ['left pane text', 'see /var/log/anymux/terminal-g'],
      ['──· 2:sh '.padEnd(30, '─'), 'ateway-2026-11-17.log for now', '┤'],
    ], 30, 30);
    expect(rowLinks(buf, 0)).toEqual([`${LOG} 1:36-1:61`]);
    expect(rowLinks(buf, 1)).toEqual([`${LOG} 2:32-2:52`]);
  });

  it('follows a line tmux broke although it starts further right', () => {
    const buf = panes([
      ['  see https://example.com/abc/de', 'x'],
      ['f/index.html', 'y'],
    ], 32, 10);
    expect(rowLinks(buf, 1)).toEqual(['https://example.com/abc/def/index.html 2:1-2:12']);
  });

  it('keeps a full row apart from the next line when its path is a file', () => {
    const buf = panes([['modified: lib/app.js', ''], ['lib/app.test.js done', '']], 20, 20);
    const files = (path) => path === 'lib/app.js' || path === 'lib/app.test.js';
    expect(rowLinks(buf, 0, files, false)).toEqual(['lib/app.js 1:11-1:20']);
    expect(rowLinks(buf, 1, files, false)).toEqual(['lib/app.test.js 2:1-2:15']);
  });

  it('is tapped in the pane under the finger, and nowhere on a border', () => {
    const term = { buffer: { active: window() } };
    expect(FP.hitTest('', 10, term, 4).text).toBe(URL);
    expect(FP.hitTest('', 50, term, 4)).toBeNull();
    const hit = FP.hitTest('', 52, term, 4);
    expect([hit.text, hit.unverified, hit.fallback.text]).toEqual([NOTES, true, 'n.md']);
  });

  it('finds the panes in a row by cells, past wide glyphs', () => {
    expect(FP.segments(mkCells([{ text: '中文│abc│' }], 12).getLine(0)))
      .toEqual([{ lo: 0, hi: 4 }, { lo: 5, hi: 8 }, { lo: 9, hi: 12 }]);
    expect(FP.segments(mkCells([{ text: 'no border here' }], 20).getLine(0))).toEqual([{ lo: 0, hi: 20 }]);
  });
});

describe('rows that only look like one token stay apart', () => {
  it('a URL on its own row, then prose', () => {
    const buf = mkCells([
      { text: '● Check the docs at:' },
      { text: '  https://docs.example.com/guide/getting-started' },
      { text: '  for details on setup.' },
    ], 80);
    expect(linkTexts(buf, unknown)[1]).toEqual(['https://docs.example.com/guide/getting-started']);
    expect(FP.linkLine(buf, 1, unknown).pending).toEqual([]);
  });

  it('two URLs, one per row', () => {
    const buf = mkCells([{ text: '  https://example.com/a' }, { text: '  https://example.com/b' }], 60);
    expect(linkTexts(buf, unknown)).toEqual([['https://example.com/a'], ['https://example.com/b']]);
  });

  it('a listing, and a sentence that ends in a path: nothing is even asked', () => {
    const listing = mkCells([
      { text: '        modified:   lib/api/files.js' },
      { text: '        modified:   plugins/files/client/js/file-preview.js' },
    ], 80);
    expect(linkTexts(listing, unknown)[0]).toEqual(['lib/api/files.js']);
    expect(FP.linkLine(listing, 0, unknown).pending).toEqual([]);
    const prose = mkCells([
      { text: '  The entry point lives in src/foo' },
      { text: '  and the tests are next to it.' },
    ], 80);
    expect(linkTexts(prose, unknown)[0]).toEqual(['src/foo']);
    expect(FP.linkLine(prose, 0, unknown).pending).toEqual([]);
  });

  it('a row that does not reach its block\'s right edge was not broken there', () => {
    const URL_ROW = '  https://example.com/abcdefghijklmnopqrstuvwxyz/0123456789/abcd';
    const NEXT = '  efgh/more and text';
    // Alone, the URL row is where the text ends, four columns from the margin.
    expect(linkTexts(mkCells([{ text: URL_ROW }, { text: NEXT }], URL_ROW.length + 4), unknown)[0])
      .toEqual(['https://example.com/abcdefghijklmnopqrstuvwxyz/0123456789/abcdefgh/more']);
    // Under a row that goes further right it is not: a wrapper had room left.
    const wider = '  ' + 'word '.repeat(13) + 'end';
    expect(linkTexts(mkCells([{ text: wider }, { text: URL_ROW }, { text: NEXT }], wider.length + 4), unknown)[1])
      .toEqual(['https://example.com/abcdefghijklmnopqrstuvwxyz/0123456789/abcd']);
  });
});

describe('a seam only the file system can decide', () => {
  // A tool line of Claude Code: the row is not full and the seam is a plain
  // letter, yet the continuation is wider than what precedes the path.
  const JOINED = 'plugins/files/client/js/file-preview.js';
  const tool = () => mkCells([
    { text: '  ⎿  Read plugins/files/client/js/file-pre' },
    { text: '     view.js (120 lines)' },
  ], 60);

  it('is left as the strict rules have it while nobody has asked, and says what to ask', () => {
    const buf = tool();
    expect(linkTexts(buf, unknown)).toEqual([['plugins/files/client/js/file-pre'], ['view.js']]);
    expect(FP.linkLine(buf, 0, unknown).pending).toEqual([JOINED]);
    expect(FP.linkLine(buf, 1, unknown).pending).toEqual([JOINED]);
  });

  it('is joined when the joined path exists', () => {
    expect(linkTexts(tool(), (path) => path === JOINED)).toEqual([[JOINED], [JOINED]]);
  });

  it('is not joined when it does not, and asks nothing more', () => {
    const buf = tool();
    expect(linkTexts(buf, () => false)).toEqual([['plugins/files/client/js/file-pre'], ['view.js']]);
    expect(FP.linkLine(buf, 0, () => false).pending).toEqual([]);
  });

  it('never joins a URL: there is nothing to check it against', () => {
    const buf = mkCells([
      { text: '  ⎿  Fetch https://example.com/docs/gett' },
      { text: '     ing-started (200 OK)' },
    ], 60);
    expect(linkTexts(buf, () => true)[0]).toEqual(['https://example.com/docs/gett']);
    expect(FP.linkLine(buf, 0, unknown).pending).toEqual([]);
  });

  it('takes a continuation that starts with an ideograph only on the file system\'s word', () => {
    const buf = mkCells([
      { text: '  docs/设计/终端链接-换行' },
      { text: '  合并方案.md' },
    ], 26);
    const joined = 'docs/设计/终端链接-换行合并方案.md';
    expect(FP.linkLine(buf, 0, unknown).pending).toEqual([joined]);
    expect(linkTexts(buf, (path) => path === joined)).toEqual([[joined], [joined]]);
  });
});

describe('columns of a link', () => {
  it('counts a glyph outside the BMP as the one cell pair it is', () => {
    // 🔧 is two string characters in one two-column cell.
    const astral = (ch) => ch.length > 1;
    const cells = [];
    for (const ch of '🔧 see src/app.js') {
      cells.push({ ch, w: astral(ch) ? 2 : 1 });
      if (astral(ch)) cells.push({ ch: '', w: 0 });
    }
    while (cells.length < 40) cells.push({ ch: '', w: 1 });
    const line = {
      isWrapped: false, length: 40,
      translateToString: (trim) => {
        const s = cells.map((c) => (c.w === 0 ? '' : c.ch || ' ')).join('');
        return trim ? s.replace(/\s+$/, '') : s;
      },
      getCell: (col) => (cells[col] ? { getWidth: () => cells[col].w, getChars: () => cells[col].ch } : undefined),
    };
    const buf = { length: 1, getLine: (i) => (i === 0 ? line : null) };
    const logical = FP.linkLine(buf, 0, unknown).logical;
    const range = FP.buildLinkRange(logical, FP.findLinks(logical.text)[0]);
    expect(range.start).toEqual({ y: 1, x: 8 });
    expect(range.end).toEqual({ y: 1, x: 17 });
  });
});

describe('a tap on a link', () => {
  const term = (buf) => ({ buffer: { active: buf } });

  it('finds a link that needs nobody\'s word at once, on either row', () => {
    const URL = 'https://example.com/aaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbb/ccc.html';
    const buf = mkCells([
      { text: 'https://example.com/aaaaaaaaa/' },
      { text: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbb/' },
      { text: 'ccc.html' },
    ], 30);
    expect(FP.hitTest('', 3, term(buf), 2)).toMatchObject({ kind: 'web', text: URL });
    expect(FP.hitTest('', 3, term(buf), 2).unverified).toBeUndefined();
  });

  it('hands over a path joined on its looks unconfirmed, and says the looks are strong', () => {
    const buf = mkCells([
      { text: '● 我已经修改了plugins/terminal/client/js/link-d' },
      { text: '  etect.js里的正则，现在可以了' },
    ], 50);
    const hit = FP.hitTest('', 4, term(buf), 1);
    expect(hit).toMatchObject({ text: 'plugins/terminal/client/js/link-detect.js', unverified: true, strong: true });
    expect(hit.fallback.text).toBe('etect.js');
    // The free columns after the first row are not the start of the second.
    expect(FP.hitTest('', 48, term(buf), 0)).toBeNull();
  });

  it('hands over an unconfirmed join with what the strict rules found to fall back on', () => {
    const buf = mkCells([
      { text: '  ⎿  Read plugins/files/client/js/file-pre' },
      { text: '     view.js (120 lines)' },
    ], 60);
    const below = FP.hitTest('', 6, term(buf), 1);
    expect(below).toMatchObject({ text: 'plugins/files/client/js/file-preview.js', unverified: true, strong: false });
    expect(below.fallback.text).toBe('view.js');
    const above = FP.hitTest('', 12, term(buf), 0);
    expect(above).toMatchObject({ unverified: true });
    expect(above.fallback.text).toBe('plugins/files/client/js/file-pre');
    // Beside the link there is nothing, joined or not.
    expect(FP.hitTest('', 20, term(buf), 1)).toBeNull();
  });
});

describe('asking whether a path exists', () => {
  const reply = (exists, status = 200) => ({ status, ok: status === 200,
    json: async () => ({ success: true, data: { exists }, error: null }) });

  it('asks once for everything, joins a request already under way, and keeps the answers per pane', async () => {
    const fetch = vi.fn(async () => reply([true, false]));
    vi.stubGlobal('fetch', fetch);
    await Promise.all([
      FP.checkExists('/n/a', '%1', ['x/one.js', 'x/two.js']),
      FP.checkExists('/n/a', '%1', ['x/one.js', 'x/two.js']),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('/n/a/api/files/exists?paneId=%251&path=x%2Fone.js&path=x%2Ftwo.js');
    expect(FP.knownToExist('/n/a', '%1', 'x/one.js')).toBe(true);
    expect(FP.knownToExist('/n/a', '%1', 'x/two.js')).toBe(false);
    // Another pane is another directory.
    expect(FP.knownToExist('/n/a', '%2', 'x/one.js')).toBeUndefined();
  });

  it('forgets a miss sooner than a hit: an agent may create the file it just named', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.stubGlobal('fetch', vi.fn(async () => reply([true, false])));
    await FP.checkExists('/n/ttl', '%1', ['here.js', 'soon.js']);
    vi.setSystemTime(1_009_000);
    expect(FP.knownToExist('/n/ttl', '%1', 'here.js')).toBe(true);
    expect(FP.knownToExist('/n/ttl', '%1', 'soon.js')).toBeUndefined();
    vi.setSystemTime(1_061_000);
    expect(FP.knownToExist('/n/ttl', '%1', 'here.js')).toBeUndefined();
  });

  it('stops asking a machine without the endpoint, and a failed request settles too', async () => {
    const old = vi.fn(async () => reply(null, 404));
    vi.stubGlobal('fetch', old);
    await FP.checkExists('/n/old', '%1', ['a.js']);
    await FP.checkExists('/n/old', '%1', ['b.js']);
    expect(old).toHaveBeenCalledTimes(1);
    expect(FP.knownToExist('/n/old', '%1', 'a.js')).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(FP.checkExists('/n/down', '%1', ['a.js'])).resolves.toBeUndefined();
    expect(FP.knownToExist('/n/down', '%1', 'a.js')).toBeUndefined();
  });
});

describe('the link provider', () => {
  const JOINED = 'plugins/files/client/js/file-preview.js';
  const tool = () => mkCells([
    { text: '  ⎿  Read plugins/files/client/js/file-pre' },
    { text: '     view.js (120 lines)' },
  ], 60);
  const reply = (exists) => ({ status: 200, ok: true, json: async () => ({ success: true, data: { exists }, error: null }) });
  // Each test its own machine: answers are remembered per machine and pane.
  function provide(buf, source) {
    let provider;
    const term = { buffer: { active: buf }, options: {}, element: null,
      registerLinkProvider: (value) => { provider = value; return { dispose() {} }; } };
    W.Api = { nodeUrl: (serverId, path) => '/n/' + serverId + path, activeServerId: () => 'local' };
    W.FilePreview.registerLinkProvider(term, '%1', null, source);
    return { term, provider };
  }
  afterEach(() => { delete W.Api; delete W.open; delete W._showToast; });

  it('answers at once when nothing waits for the file system', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { provider } = provide(mkCells([
      { text: 'https://example.com/aaaaaaaaa/' },
      { text: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbb/' },
      { text: 'ccc.html' },
    ], 30), { serverId: 'sure', paneId: '%1' });
    let links;
    provider.provideLinks(2, (value) => { links = value; });
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe('https://example.com/aaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbb/ccc.html');
    expect(links[0].range).toEqual({ start: { y: 1, x: 1 }, end: { y: 3, x: 8 } });
    expect(fetch).not.toHaveBeenCalled();
  });

  describe('for a path on a seam that looks sure', () => {
    const PATH = 'plugins/terminal/client/js/link-detect.js';
    const claude = () => mkCells([
      { text: '● 我已经修改了plugins/terminal/client/js/link-d' },
      { text: '  etect.js里的正则，现在可以了' },
    ], 50);

    it('asks all the same, about the joined path and about each half', async () => {
      const fetch = vi.fn(async () => reply([true, false, false]));
      vi.stubGlobal('fetch', fetch);
      const { provider } = provide(claude(), { serverId: 'strong', paneId: '%1' });
      const answered = vi.fn();
      provider.provideLinks(2, answered);
      await vi.waitFor(() => expect(answered).toHaveBeenCalledTimes(1));
      expect(fetch.mock.calls[0][0]).toBe('/n/strong/api/files/exists?paneId=%251'
        + ['', PATH, 'plugins/terminal/client/js/link-d', 'etect.js'].map(encodeURIComponent).join('&path='));
      expect(answered.mock.calls[0][0][0]).toMatchObject({ text: PATH,
        range: { start: { y: 1, x: 15 }, end: { y: 2, x: 10 } } });
    });

    it('joins on its looks when the machine has no answer to give', async () => {
      // A Node from before the endpoint.
      vi.stubGlobal('fetch', vi.fn(async () => ({ status: 404, ok: false, json: async () => ({}) })));
      const { provider } = provide(claude(), { serverId: 'older', paneId: '%1' });
      const answered = vi.fn();
      provider.provideLinks(1, answered);
      await vi.waitFor(() => expect(answered).toHaveBeenCalledTimes(1));
      expect(answered.mock.calls[0][0].map((link) => link.text)).toEqual([PATH]);
    });

    it('keeps the rows apart when one of them is a file by itself', async () => {
      const ALONE = 'plugins/files/client/js/file-preview.js';
      // Asked in this order: the joined path, then the row's own.
      vi.stubGlobal('fetch', vi.fn(async () => reply([false, true])));
      const { provider } = provide(mkCells([
        { text: '● Updated the file at' },
        { text: '  ' + ALONE },
        { text: '  and ran the tests.' },
      ], 46), { serverId: 'apart', paneId: '%1' });
      const answered = vi.fn();
      provider.provideLinks(2, answered);
      await vi.waitFor(() => expect(answered).toHaveBeenCalledTimes(1));
      expect(answered.mock.calls[0][0].map((link) => link.text)).toEqual([ALONE]);
    });
  });

  it('asks the pane\'s machine about a seam it is not sure of, then answers with the joined link', async () => {
    const fetch = vi.fn(async () => reply([true]));
    vi.stubGlobal('fetch', fetch);
    const { provider } = provide(tool(), { serverId: 'joins', paneId: '%9' });
    const answered = vi.fn();
    provider.provideLinks(2, answered);
    expect(answered).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(answered).toHaveBeenCalledTimes(1));
    expect(fetch.mock.calls[0][0]).toBe('/n/joins/api/files/exists?paneId=%259&path=' + encodeURIComponent(JOINED));
    const links = answered.mock.calls[0][0];
    expect(links.map((link) => link.text)).toEqual([JOINED]);
    expect(links[0].range).toEqual({ start: { y: 1, x: 11 }, end: { y: 2, x: 12 } });
    // The answer is remembered: the next repaint under the pointer costs nothing.
    let again;
    provider.provideLinks(1, (value) => { again = value; });
    expect(again.map((link) => link.text)).toEqual([JOINED]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps what the strict rules found when the joined path is not there', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply([false])));
    const { provider } = provide(tool(), { serverId: 'misses', paneId: '%1' });
    const answered = vi.fn();
    provider.provideLinks(2, answered);
    await vi.waitFor(() => expect(answered).toHaveBeenCalledTimes(1));
    expect(answered.mock.calls[0][0].map((link) => link.text)).toEqual(['view.js']);
  });

  it('answers only the request xterm still waits for', async () => {
    let release;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { release = () => resolve(reply([true])); })));
    const { provider } = provide(tool(), { serverId: 'moves', paneId: '%1' });
    const first = vi.fn();
    const second = vi.fn();
    provider.provideLinks(1, first);
    // The pointer moved on: xterm asks for the next row and stops listening for this one.
    provider.provideLinks(2, second);
    release();
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(first).not.toHaveBeenCalled();
  });

  it('gives a link over rows of one pane as a link per row, each underlining the others', () => {
    vi.stubGlobal('fetch', vi.fn());
    const URL = 'https://example.com/abcdefghijklmnopqrstuvwxyz/0123';
    const { provider } = provide(mkCells([
      { text: 'https://example.com/abcdefghijklmnopqr│right pane' },
      { text: 'stuvwxyz/0123                         │more text' },
    ], 50), { serverId: 'split', paneId: '%1' });
    let links;
    provider.provideLinks(1, (value) => { links = value; });
    // Not the cells to the end of the row: those are the next pane's.
    expect(links.map((link) => [link.text, link.range])).toEqual([[URL, { start: { y: 1, x: 1 }, end: { y: 1, x: 38 } }]]);
    expect(typeof links[0].hover).toBe('function');
    links[0].hover();
    links[0].leave();
    provider.provideLinks(2, (value) => { links = value; });
    expect(links.map((link) => [link.text, link.range])).toEqual([[URL, { start: { y: 2, x: 1 }, end: { y: 2, x: 13 } }]]);
  });

  it('asks nothing while the terminal is not confirmed to be the pane\'s', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { provider } = provide(tool(), { serverId: 'unsure', paneId: '%1', isCurrent: () => false });
    let links;
    provider.provideLinks(2, (value) => { links = value; });
    expect(links.map((link) => link.text)).toEqual(['view.js']);
    expect(fetch).not.toHaveBeenCalled();
  });

  describe('for hyperlinks the program marked itself (OSC 8)', () => {
    it('opens a web link in the click and names a scheme it does not open', () => {
      W.open = vi.fn();
      W._showToast = vi.fn();
      const { term } = provide(mkCells([{ text: 'x' }], 20), { serverId: 'osc', paneId: '%1' });
      const handler = term.options.linkHandler;
      // file: links and bare paths would not even reach the handler otherwise.
      expect(handler.allowNonHttpProtocols).toBe(true);
      handler.activate({}, 'https://example.com/a');
      expect(W.open).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener');
      handler.activate({}, 'vscode://file/home/u/a.ts');
      handler.activate({}, 'javascript:alert(1)');
      expect(W.open).toHaveBeenCalledTimes(1);
      expect(W._showToast).toHaveBeenCalledTimes(2);
      expect(W._showToast.mock.calls[0][0]).toContain('vscode');
    });

    it('shows where a link leads while the pointer is on it', () => {
      const { term } = provide(mkCells([{ text: 'x' }], 20), { serverId: 'osc', paneId: '%1' });
      term.element = { title: '', removeAttribute: vi.fn() };
      term.options.linkHandler.hover({}, 'https://example.com/real-target');
      expect(term.element.title).toBe('https://example.com/real-target');
      term.options.linkHandler.leave({}, 'https://example.com/real-target');
      expect(term.element.removeAttribute).toHaveBeenCalledWith('title');
    });

    it('does not open a file while the terminal is not confirmed to be the pane\'s', () => {
      W._showToast = vi.fn();
      const { term } = provide(mkCells([{ text: 'x' }], 20), { serverId: 'osc', paneId: '%1', isCurrent: () => false });
      term.options.linkHandler.activate({}, 'file:///home/u/notes.md');
      expect(W._showToast).toHaveBeenCalledWith('终端来源尚未确认，请连接后重试');
    });

    describe('that run over several rows', () => {
      // xterm's own provider answers one row at a time; `cells` says which
      // columns (from 1, both included) of each row lead where.
      const URL = 'https://example.com/a/long/address';
      function linked(rows, cols) {
        const { term } = provide(mkCells(rows, cols), { serverId: 'osc', paneId: '%1' });
        term._core = { _linkProviderService: { linkProviders: [{
          _oscLinkService: {},
          provideLinks(y, callback) {
            callback((rows[y - 1].cells || []).map(([from, to, uri]) => (
              { text: uri, range: { start: { x: from, y }, end: { x: to, y } } })));
          },
        }, {}] } };
        return term;
      }
      const cellsOf = (ranges) => ranges.map((range) => [range.start.y, range.start.x, range.end.x]);
      const at = (y, from, to) => ({ start: { x: from, y }, end: { x: to, y } });

      it('finds the rows of a link a TUI wrapped, from whichever row the pointer is on', () => {
        const term = linked([
          { text: '• see https://example.com/a/', cells: [[7, 28, URL]] },
          { text: '  long/', cells: [[3, 7, URL]] },
          { text: '  address for more', cells: [[3, 9, URL]] },
        ], 30);
        expect(cellsOf(FP.hyperlinkRows(term, URL, at(1, 7, 28)))).toEqual([[2, 3, 7], [3, 3, 9]]);
        expect(cellsOf(FP.hyperlinkRows(term, URL, at(2, 3, 7)))).toEqual([[3, 3, 9], [1, 7, 28]]);
        expect(cellsOf(FP.hyperlinkRows(term, URL, at(3, 3, 9)))).toEqual([[2, 3, 7], [1, 7, 28]]);
      });

      it('finds the rest of a link the terminal wrapped, and one inside a tmux pane', () => {
        const soft = linked([
          { text: 'x'.repeat(20), cells: [[1, 20, URL]] },
          { text: 'xxxx', wrapped: true, cells: [[1, 4, URL]] },
        ], 20);
        expect(cellsOf(FP.hyperlinkRows(soft, URL, at(1, 1, 20)))).toEqual([[2, 1, 4]]);
        const split = linked([
          { text: 'left pane │ see https://e.com/', cells: [[17, 30, URL]] },
          { text: 'more left │   long/address', cells: [[15, 26, URL]] },
        ], 30);
        expect(cellsOf(FP.hyperlinkRows(split, URL, at(1, 17, 30)))).toEqual([[2, 15, 26]]);
      });

      it('leaves alone a row that leads elsewhere, or names the same address again', () => {
        const term = linked([
          { text: '  https://example.com/one', cells: [[3, 25, 'https://example.com/one']] },
          { text: '  https://example.com/two', cells: [[3, 25, 'https://example.com/two']] },
          { text: '  and again: one', cells: [[14, 16, 'https://example.com/two']] },
        ], 30);
        expect(FP.hyperlinkRows(term, 'https://example.com/one', at(1, 3, 25))).toEqual([]);
        expect(FP.hyperlinkRows(term, 'https://example.com/two', at(2, 3, 25))).toEqual([]);
      });

      it('underlines one row, as xterm does, in a build without that provider', () => {
        const { term } = provide(mkCells([{ text: 'x' }], 20), { serverId: 'osc', paneId: '%1' });
        expect(FP.hyperlinkRows(term, URL, at(1, 1, 1))).toEqual([]);
      });
    });
  });
});

describe('pane context resolution', () => {
  it('uses the live active pane supplied by split mode', async () => {
    const used = await FP.resolvePaneForAction('%1', () => Promise.resolve('%2'), (paneId) => paneId);
    expect(used).toBe('%2');
  });

  it('falls back to the attached pane when live lookup fails', async () => {
    const used = await FP.resolvePaneForAction('%1', () => Promise.reject(new Error('offline')), (paneId) => paneId);
    expect(used).toBe('%1');
  });

  it('does not retry the action when the action itself fails', async () => {
    var calls = 0;
    await expect(FP.resolvePaneForAction('%1', () => '%2', () => {
      calls++;
      throw new Error('open failed');
    })).rejects.toThrow('open failed');
    expect(calls).toBe(1);
  });
});
