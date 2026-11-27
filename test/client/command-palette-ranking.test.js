import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const paletteSrc = readFileSync(resolve('plugins/ui/client/js/command-palette.js'), 'utf8');

function bootPalette() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://panel.local/',
    runScripts: 'outside-only',
  });
  dom.window.eval(paletteSrc);
  return { win: dom.window, testApi: dom.window.CommandPalette._test };
}

describe('wave 4 CommandPalette fuzzy ranking, folding, top-K & MRU boost', () => {
  it('supports camelCase, separator equivalence (-/_ /space), and NFKD/NFKC folding', () => {
    const { testApi } = bootPalette();

    // camelCase boundary match
    const camel = testApi.matchWord('fb', 'openFooBarBaz');
    expect(camel).not.toBeNull();
    expect(camel.positions.length).toBeGreaterThanOrEqual(2);

    // Separator equivalence
    const sep = testApi.matchWord('foo-bar', 'my_foo_bar_helper');
    expect(sep).not.toBeNull();

    // Unicode diacritics folded via NFKD
    expect(testApi.normalized('Café Résumé')).toBe('cafe resume');
    expect(testApi.matchWord('cafe', 'Café Logs')).not.toBeNull();
  });

  it('scores both title and meta highlights and boosts MRU items accurately', () => {
    const { win, testApi } = bootPalette();
    const item = {
      key: 'cmd:restart',
      display: 'Restart Service',
      meta: 'development workspace',
      search: testApi.normalized('Restart Service development workspace'),
    };
    const scoredBefore = testApi.scoreItem(item, ['restart', 'dev']);
    expect(scoredBefore).not.toBeNull();
    expect(scoredBefore.highlight.length).toBeGreaterThan(0);
    expect(scoredBefore.metaHighlight.length).toBeGreaterThan(0);

    // Record item in localStorage MRU map and reload palette state
    win.localStorage.setItem('anymux_palette_mru_v1', JSON.stringify({ 'cmd:restart': Date.now() }));
    win.eval(paletteSrc);
    const boosted = win.CommandPalette._test.scoreItem(item, ['restart', 'dev']);
    expect(boosted.score).toBeGreaterThan(scoredBefore.score);
  });

  it('extracts deterministic top-K entries via min-heap without sorting whole array wrong', () => {
    const { testApi } = bootPalette();
    const items = Array.from({ length: 200 }, (_, i) => ({ score: (i * 37) % 199, order: i }));
    const top5 = testApi.topKEntries(items, 5, (a, b) => b.score - a.score || a.order - b.order);
    expect(top5.map((x) => x.score)).toEqual([198, 197, 196, 195, 194]);
  });
});
