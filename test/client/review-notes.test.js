import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const blocksKitSrc = readFileSync(resolve('plugins/ui/client/js/blocks-kit.js'), 'utf8');
const reviewNotesSrc = readFileSync(resolve('plugins/ui/client/js/review-notes.js'), 'utf8');

function bootReviewDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="diff-host"></div></body></html>', {
    url: 'https://panel.local/',
    runScripts: 'outside-only',
  });
  const win = dom.window;
  win.Api = {
    activeServerId: () => 'local',
    nodeUrl: (_sid, path) => path,
  };
  win.Auth = { headers: () => ({ Authorization: 'Bearer tok' }) };
  win.AppShell = { workspace: () => ({ instanceId: '18130:100' }) };
  win.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  win.eval(blocksKitSrc);
  win.eval(reviewNotesSrc);
  // Provide selectedContext returning target pane
  win.Blocks.ui.selectedContext = () => ({ serverId: 'local', paneId: '%12', instanceId: '18130:100' });
  return { dom, win, host: win.document.getElementById('diff-host') };
}

const SAMPLE_DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -10,4 +10,5 @@ function run()',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' return a + b;',
].join('\n');

describe('wave 4 ReviewNotes & inline diff review workflow', () => {
  it('stores, formats, and injects multi-line review notes to /api/agent-docs/prefill without Enter', async () => {
    const { win } = bootReviewDom();
    const note = win.ReviewNotes.addNote({
      scopeKey: 'git:/repo',
      path: 'src/app.js',
      startLine: 11,
      endLine: 12,
      excerpt: '+const b = 3;\n+const c = 4;',
      comment: 'Extract sum helper here',
    });
    expect(note.id).toBeTruthy();
    const md = win.ReviewNotes.formatReviewMarkdown([note]);
    expect(md).toContain('Review note on `src/app.js:L11-L12`:');
    expect(md).toContain('> +const b = 3;');
    expect(md).toContain('Extract sum helper here');

    const ok = await win.ReviewNotes.injectToTerminal([note]);
    expect(ok).toBe(true);
    expect(win.fetch).toHaveBeenCalledWith(
      '/api/agent-docs/prefill',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ paneId: '%12', text: md, serverInstance: '18130:100' }),
      }),
    );
  });

  it('supports gutter + hover & drag line-range composer without triggering .blk-line staging and survives re-render', async () => {
    const { win, host } = bootReviewDom();
    const selectedCalls = [];
    const actionsFn = (_file, _hunk, picked) => {
      const btn = win.document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Stage';
      btn.addEventListener('click', () => selectedCalls.push(picked()));
      return [btn];
    };

    win.Blocks.ui.renderDiffInto(host, SAMPLE_DIFF, {
      actions: actionsFn,
      reviewScope: 'git:/repo',
      paneId: '%12',
    });

    const addLines = [...host.querySelectorAll('.blk-line.is-add')];
    expect(addLines).toHaveLength(2);
    const noteBtn0 = addLines[0].querySelector('.blk-diff-note-btn');
    expect(noteBtn0).not.toBeNull();

    // Drag across both added lines
    noteBtn0.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    addLines[1].dispatchEvent(new win.MouseEvent('mouseenter', { bubbles: true }));
    win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));

    // Ensure line staging was NOT triggered by gutter mousedown/click
    expect(addLines[0].classList.contains('is-selected')).toBe(false);
    expect(host.querySelectorAll('[data-blk-note-editor]')).toHaveLength(1);

    const ta = host.querySelector('.blk-diff-note-input');
    ta.value = 'Double check overflow';
    host.querySelector('.blk-diff-note-editor').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));

    expect(host.querySelector('.blk-diff-note-chip')).not.toBeNull();
    expect(host.querySelector('.blk-diff-note-body').textContent).toBe('Double check overflow');

    // Simulate 4s Git poll re-render: saved note re-hydrates from external ReviewNotes store!
    win.Blocks.ui.renderDiffInto(host, SAMPLE_DIFF, {
      actions: actionsFn,
      reviewScope: 'git:/repo',
      paneId: '%12',
    });
    expect(host.querySelector('.blk-diff-note-body')?.textContent).toBe('Double check overflow');

    // Click Inject to Terminal button -> posts /api/agent-docs/prefill without Enter
    host.querySelector('.blk-diff-note-inject').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(win.fetch).toHaveBeenCalledWith(
      '/api/agent-docs/prefill',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
