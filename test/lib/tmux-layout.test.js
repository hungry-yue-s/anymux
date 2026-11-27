import { describe, it, expect } from 'vitest';
import {
  extractLayoutRatios,
  layoutTopologySignature,
  parseLayoutRatios,
  parseTmuxLayout,
  scaleTmuxLayout,
  serializeTmuxLayout,
  tmuxLayoutChecksum,
} from '../../lib/terminal/tmux-layout.js';

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

  it('round-trips serialized layouts and scales asymmetrically split trees proportionally across shrink and expand', () => {
    const src = withChecksum('121x40,0,0{30x40,0,0,1,90x40,31,0,2}');
    const tree = parseTmuxLayout(src);
    expect(serializeTmuxLayout(tree)).toBe(src);
    expect(layoutTopologySignature(tree)).toBe('row(pane(%1),pane(%2))');

    const intent = extractLayoutRatios(tree);
    expect(parseLayoutRatios(JSON.stringify(intent))).toEqual(intent);

    // Shrink 121 -> 81 cols: separator=1, 80 usable cols in 1:3 => 20:60 (NOT 10:70 equal subtraction)
    const shrunkStr = scaleTmuxLayout(tree, 81, 30, intent);
    const shrunk = parseTmuxLayout(shrunkStr);
    expect(shrunk.children.map((c) => [c.paneId, c.width, c.height, c.x])).toEqual([
      ['%1', 20, 30, 0],
      ['%2', 60, 30, 21],
    ]);

    // Extreme shrink where pane %1 (5% weight of 9 => clamped to 1 col), then re-expand to 201 cols:
    // passing original `intent` recovers exact 1:3 (50:150) rather than drifting!
    const extremeTinyStr = withChecksum('100x40,0,0{5x40,0,0,1,94x40,6,0,2}');
    const tinyIntent = extractLayoutRatios(parseTmuxLayout(extremeTinyStr));
    const clampedStr = scaleTmuxLayout(parseTmuxLayout(extremeTinyStr), 11, 20, tinyIntent);
    const clamped = parseTmuxLayout(clampedStr);
    expect(clamped.children[0].width).toBe(1);
    expect(clamped.children[1].width).toBe(9);

    const restoredStr = scaleTmuxLayout(clamped, 100, 40, tinyIntent);
    const restored = parseTmuxLayout(restoredStr);
    expect(restored.children.map((c) => c.width)).toEqual([5, 94]);
  });

  it('scales nested mixed splits proportionally and honors pane-border minimums', () => {
    const nested = parseTmuxLayout(withChecksum('160x48,0,0{40x48,0,0,5,119x48,41,0[119x12,41,0,6,119x35,41,13{59x35,41,13,7,59x35,101,13,8}]}'));
    const intent = extractLayoutRatios(nested);
    const scaled = parseTmuxLayout(scaleTmuxLayout(nested, 80, 24, intent, {
      paneMinById: new Map([['%6', { w: 1, h: 2 }]]),
    }));
    expect(scaled.width).toBe(80);
    expect(scaled.height).toBe(24);
    expect(scaled.children[0].width).toBe(20);
    expect(scaled.children[1].width).toBe(59);
    expect(scaled.children[1].children[0].height).toBeGreaterThanOrEqual(5);
    expect(scaled.children[1].children[1].children.map((c) => c.width)).toEqual([29, 29]);
  });
});
