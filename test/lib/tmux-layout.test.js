import { describe, it, expect } from 'vitest';
import { parseTmuxLayout, tmuxLayoutChecksum } from '../../lib/terminal/tmux-layout.js';

const withChecksum = (body) => `${tmuxLayoutChecksum(body)},${body}`;

describe('tmux layout parser', () => {
  it('parses a single-pane layout with verified checksum', () => {
    const tree = parseTmuxLayout(withChecksum('160x48,0,0,5'));
    expect(tree).toEqual({ type: 'pane', paneId: '%5', width: 160, height: 48, x: 0, y: 0 });
  });

  it('parses binary and N-ary row and column splits', () => {
    const threeCols = withChecksum('160x48,0,0{53x48,0,0,1,53x48,54,0,2,52x48,108,0,3}');
    expect(parseTmuxLayout(threeCols)).toEqual({
      type: 'split',
      dir: 'row',
      width: 160,
      height: 48,
      x: 0,
      y: 0,
      children: [
        { type: 'pane', paneId: '%1', width: 53, height: 48, x: 0, y: 0 },
        { type: 'pane', paneId: '%2', width: 53, height: 48, x: 54, y: 0 },
        { type: 'pane', paneId: '%3', width: 52, height: 48, x: 108, y: 0 },
      ],
    });

    const fourRows = withChecksum('80x40,0,0[80x9,0,0,0,80x9,0,10,1,80x9,0,20,2,80x10,0,30,3]');
    const parsedRows = parseTmuxLayout(fourRows);
    expect(parsedRows?.dir).toBe('col');
    expect(parsedRows?.children.map((c) => c.paneId)).toEqual(['%0', '%1', '%2', '%3']);
  });

  it('parses deeply nested mixed row/col layouts', () => {
    const nested = withChecksum('160x48,0,0{80x48,0,0,5,79x48,81,0[79x28,81,0,6,79x19,81,29{39x19,81,29,7,39x19,121,29,8}]}');
    const tree = parseTmuxLayout(nested);
    expect(tree).toMatchObject({
      type: 'split',
      dir: 'row',
      children: [
        { type: 'pane', paneId: '%5', width: 80, height: 48 },
        {
          type: 'split',
          dir: 'col',
          x: 81,
          children: [
            { type: 'pane', paneId: '%6', width: 79, height: 28 },
            {
              type: 'split',
              dir: 'row',
              y: 29,
              children: [
                { type: 'pane', paneId: '%7', width: 39, height: 19 },
                { type: 'pane', paneId: '%8', width: 39, height: 19 },
              ],
            },
          ],
        },
      ],
    });
  });

  it('matches known real tmux layout checksum and returns null for malformed inputs', () => {
    // Known valid tmux layout: checksum(80x24,0,0,0) computed directly by tmux
    const body = '80x24,0,0,0';
    const valid = withChecksum(body);
    expect(parseTmuxLayout(valid)).toEqual({ type: 'pane', paneId: '%0', width: 80, height: 24, x: 0, y: 0 });
    expect(parseTmuxLayout(null)).toBeNull();
    expect(parseTmuxLayout('')).toBeNull();
    expect(parseTmuxLayout('zzzz,80x24,0,0,0')).toBeNull();
    expect(parseTmuxLayout('0000,80x24,0,0,0')).toBeNull(); // bad checksum (unless body hashes to 0000)
    expect(parseTmuxLayout(withChecksum('0x24,0,0,0'))).toBeNull();
    expect(parseTmuxLayout(withChecksum('80x24,0,0{40x24,0,0,1'))).toBeNull();
    expect(parseTmuxLayout(withChecksum('80x24,0,0{40x24,0,0,1}extra'))).toBeNull();
  });
});
