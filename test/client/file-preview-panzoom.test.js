import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const filePreviewSrc = readFileSync(resolve('plugins/files/client/js/file-preview.js'), 'utf8');

function bootFilePreview() {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    url: 'https://panel.local/',
    runScripts: 'outside-only',
  });
  const win = dom.window;
  win.Auth = { headers: () => ({ Authorization: 'Bearer fp-tok' }) };
  win.fetch = vi.fn().mockResolvedValue({
    ok: true,
    text: async () => '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="8"/></svg>',
  });
  win.eval(filePreviewSrc);
  return { win, host: win.document.getElementById('host'), testApi: win.FilePreview._test };
}

describe('wave 4 FilePreview pan-zoom image viewer, SVG source toggle, and Mermaid contrast', () => {
  it('mounts pan-zoom toolbar, tracks zoom/checkerboard/drag/WxH, and fetches SVG raw source with Auth headers', async () => {
    const { win, host, testApi } = bootFilePreview();
    testApi.renderImage(host, '/api/files/raw?path=%2Ftmp%2Flogo.svg', 'logo.svg');

    const img = host.querySelector('img');
    const stage = host.querySelector('.fp-panzoom-stage');
    const pct = host.querySelector('.fp-panzoom-pct');
    const meta = host.querySelector('.fp-panzoom-meta');
    const btns = [...host.querySelectorAll('.fp-panzoom-btn')];
    const findBtn = (label) => btns.find((b) => b.textContent === label);

    Object.defineProperty(img, 'naturalWidth', { value: 640 });
    Object.defineProperty(img, 'naturalHeight', { value: 480 });
    img.dispatchEvent(new win.Event('load'));
    expect(meta.textContent).toBe('640 × 480');
    expect(pct.textContent).toBe('Fit');

    findBtn('1:1').click();
    expect(pct.textContent).toBe('100%');
    expect(img.style.transform).toContain('scale(1.0000)');

    findBtn('+').click();
    expect(pct.textContent).toBe('125%');

    findBtn('棋盘格').click();
    expect(stage.classList.contains('is-checkerboard')).toBe(true);

    // SVG source toggle fetches /api/files/raw as text (not /api/files/content)
    const srcBtn = findBtn('源码');
    expect(srcBtn).toBeTruthy();
    srcBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(win.fetch).toHaveBeenCalledWith(
      '/api/files/raw?path=%2Ftmp%2Flogo.svg',
      expect.objectContaining({ headers: { Authorization: 'Bearer fp-tok' } }),
    );
    expect(stage.hidden).toBe(true);
    expect(host.querySelector('.fp-svg-source').hidden).toBe(false);
  });

  it('repairs low-contrast custom-styled Mermaid flowchart node labels', () => {
    const { win, testApi } = bootFilePreview();
    const wrap = win.document.createElement('div');
    wrap.innerHTML = `<svg aria-roledescription="flowchart-v2" width="120" height="80">
      <g class="node">
        <rect class="label-container" fill="#ffffff" style="fill: rgb(255, 255, 255); fill-opacity: 1; opacity: 1;"></rect>
        <g class="label"><text fill="#eeeeee" style="fill: rgb(238, 238, 238);">Low Contrast</text></g>
      </g>
    </svg>`;
    win.document.body.appendChild(wrap);
    testApi.adaptMermaidPalette(wrap.querySelector('svg'));
    const textFill = wrap.querySelector('text').style.getPropertyValue('fill');
    expect(textFill).toBeTruthy();
    expect(textFill).not.toBe('#eeeeee');
  });
});
