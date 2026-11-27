import { indexSource as composedIndex } from '../helpers/pages.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { loadSlots } from '../helpers/slots.js';

const themeSource = readFileSync('plugins/ui/client/js/theme.js', 'utf8');
const terminalSource = readFileSync('plugins/terminal/client/js/terminal.js', 'utf8');
const serversSource = readFileSync('plugins/ui/client/js/servers.js', 'utf8');
const appShellSource = readFileSync('plugins/ui/client/js/app-shell.js', 'utf8');
const msAppSource = readFileSync('plugins/ui/client/js/ms-app.js', 'utf8');
const indexSource = composedIndex();

let dom;

function loadTheme(themeId, { native = false, transparency, legacyNative = false, glass, appearance = false, engine, liquid = false, mobile = false } = {}) {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://anymux.test/',
  });
  if (themeId) dom.window.localStorage.setItem('tmux_theme', themeId);
  if (transparency !== undefined) dom.window.localStorage.setItem('tmux_native_transparency', transparency);
  if (glass !== undefined) dom.window.localStorage.setItem('tmux_native_glass_intensity', glass);
  if (appearance) dom.window.webkit = {
    messageHandlers: { anymuxAppearance: { postMessage: vi.fn() } },
  };
  if (native) dom.window.__anymuxTransparency = true;
  if (engine) dom.window.__anymuxGlassEngine = engine;
  if (liquid) dom.window.__anymuxLiquidGlass = true;
  if (mobile) dom.window.MobileUI = { isMobile: () => true };
  if (legacyNative) dom.window.document.documentElement.classList.add('tmux-native-shell');
  dom.window.eval(themeSource);
  return dom.window.Theme;
}

function renderSettings() {
  dom.window.Store = { getState: () => ({ ui: { showPerformance: true } }) };
  loadSlots(dom.window);
  dom.window.eval(appShellSource);
  dom.window.AppShell.setHeader = vi.fn();
  dom.window.eval(serversSource);
  dom.window.document.body.innerHTML = dom.window.ServersPage.renderSettings();
}

function storageChange(key, value) {
  if (key === null) dom.window.localStorage.clear();
  else if (value === null) dom.window.localStorage.removeItem(key);
  else dom.window.localStorage.setItem(key, value);
  dom.window.dispatchEvent(new dom.window.StorageEvent('storage', {
    key,
    newValue: value,
    storageArea: dom.window.localStorage,
  }));
}

afterEach(() => {
  if (dom) dom.window.close();
  dom = null;
});

describe('extended terminal themes', () => {
  it('registers four distinct new palettes and their preview metadata', () => {
    const Theme = loadTheme();
    for (const id of ['prism', 'graphite', 'forest-ink', 'oyster']) {
      const theme = Theme.getThemeList().find((entry) => entry.id === id);
      expect(theme.description).toBeTruthy();
      expect(theme.terminal.background).toBe(theme.colors['--workspace-bg']);
      expect(theme.colorScheme).toBe(id === 'oyster' ? 'light' : 'dark');
    }
  });

  it('applies a new palette to both UI and terminal', () => {
    const Theme = loadTheme('prism');
    expect(Theme.getCurrent()).toBe('prism');
    expect(Theme.getTerminalTheme().background).toBe('#191923');
    expect(dom.window.document.documentElement.getAttribute('data-theme')).toBe('prism');
    expect(dom.window.document.documentElement.style.getPropertyValue('--bg-primary')).toBe('#191923');
  });

  it.each([
    ['tokyo-night-storm', 'tokyo-night'], ['catppuccin-mocha', 'prism'],
    ['catppuccin-mocha-pastel', 'prism'], ['rose-pine-moon', 'prism'],
    ['dracula', 'prism'], ['one-dark', 'graphite'], ['solarized-dark', 'deep-current'],
  ])('migrates retired %s to %s one-way without legacy key back-overwrite', (oldId, newId) => {
    const Theme = loadTheme(oldId, { native: true, transparency: '25', glass: '65', appearance: true });
    expect(Theme.getCurrent()).toBe(newId);
    expect(Theme.getThemeList().some((theme) => theme.id === oldId)).toBe(false);
    expect(Theme.getTerminalTheme(oldId)).toEqual(Theme.getTerminalTheme(newId));
    expect(Theme.getName(oldId)).toBe(Theme.getName(newId));
    expect([Theme.getTransparency(), Theme.getGlassIntensity()]).toEqual([25, 65]);

    // Applying a new theme writes ONLY anymux_appearance_v4; legacy keys must not overwrite v4.
    Theme.apply('github-light');
    expect(dom.window.localStorage.getItem('anymux_appearance_v4')).toContain('github-light');
    storageChange('tmux_theme', oldId);
    storageChange('tmux_native_transparency', '10');
    storageChange('anymux_appearance_v3', JSON.stringify({ version: 3, themeUpdatedAt: Date.now() + 5000, theme: { themeId: 'oyster' } }));
    expect(Theme.getCurrent()).toBe('github-light');
    expect(Theme.getTransparency()).toBe(25);
  });

  it.each(['unknown-theme', '__proto__', 'toString'])('safely falls back for invalid saved theme %s', (id) => {
    const Theme = loadTheme(id);
    expect(Theme.getCurrent()).toBe('tokyo-night');
    Theme.apply(id);
    expect(Theme.getCurrent()).toBe('tokyo-night');
    expect(Theme.getTerminalTheme(id)).toEqual(Theme.getTerminalTheme('tokyo-night'));
  });

  it('announces theme changes so rendered previews can rebuild embedded colors', () => {
    const Theme = loadTheme();
    const listener = vi.fn();
    dom.window.document.addEventListener('tmux-theme-change', listener);

    Theme.apply('github-light');

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].detail.themeId).toBe('github-light');
  });

  it('loads the theme before its terminal and preview consumers', () => {
    const page = new JSDOM(indexSource, { url: 'https://anymux.test/' });
    try {
      // Content-hash caching is verified by weak-network.test.js; asset presence
      // and load order must not depend on a historical manual ?v= counter.
      const scripts = [...page.window.document.querySelectorAll('script[src]')].map((script) => new URL(script.src).pathname);
      const styles = [...page.window.document.querySelectorAll('link[rel="stylesheet"]')].map((link) => new URL(link.href).pathname);
      expect(scripts).toEqual(expect.arrayContaining(['/js/theme.js', '/js/terminal.js', '/js/file-preview.js']));
      expect(styles).toContain('/css/style.css');
      for (const consumer of ['/js/terminal.js', '/js/file-preview.js']) {
        expect(scripts.indexOf('/js/theme.js')).toBeLessThan(scripts.indexOf(consumer));
      }
    } finally { page.window.close(); }
  });
});

// Independent WCAG calculation for opaque colors and an 8% backdrop stress case.
// This does not guarantee contrast at arbitrary user-selected window transparency.
function contrastRatio(foreground, background) {
  const linear = (value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (color) => color.reduce((sum, value, index) =>
    sum + linear(value) * [0.2126, 0.7152, 0.0722][index], 0);
  const [a, b] = [luminance(foreground), luminance(background)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const channels = (color) => [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));

describe('workbench semantic palettes', () => {
  it('curates ten choices while retaining the existing default', () => {
    const Theme = loadTheme();
    expect(Theme.getCurrent()).toBe('tokyo-night');
    expect(Theme.getThemeList().map(({ id }) => id)).toEqual([
      'prism', 'graphite', 'deep-current', 'forest-ink', 'tokyo-night', 'nord',
      'gruvbox-dark', 'oyster', 'solarized-light', 'github-light',
    ]);
  });

  it('provides readable text and accent across opaque surfaces and lightly tinted backdrops', () => {
    const Theme = loadTheme();
    for (const { id, colors } of Theme.getThemeList()) {
      Theme.apply(id);
      const root = dom.window.document.documentElement;
      const alpha = 0.92;
      const scheme = ['github-light', 'solarized-light', 'oyster'].includes(id) ? 'light' : 'dark';
      expect(root.style.colorScheme, id).toBe(scheme);
      for (const surface of ['bg', 'sidebar', 'panel', 'hover']) {
        const hex = colors['--workspace-' + surface];
        expect(hex, id + ': ' + surface).toMatch(/^#[0-9a-f]{6}$/i);
        expect(root.style.getPropertyValue('--workspace-' + surface)).toBe(hex);
        const opaque = channels(hex);
        // Stress the surface with 8% black/white, independently of native sliders.
        const backdrops = [opaque, ...[0, 255].map((value) =>
          opaque.map((channel) => channel * alpha + value * (1 - alpha)))];
        for (const background of backdrops) {
          for (const name of ['text', 'muted', 'accent']) {
            const contrast = contrastRatio(channels(colors['--workspace-' + name]), background);
            expect(contrast, id + '/' + surface + '/' + name).toBeGreaterThanOrEqual(4.5);
          }
          expect(contrastRatio(channels(colors['--workspace-line-strong']), background),
            id + '/' + surface + '/control boundary').toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it('preserves classic ANSI slots used by TUI backgrounds and reverse video', () => {
    const Theme = loadTheme();
    for (const [id, unchanged] of [
      ['tokyo-night', { foreground: '#c0caf5', blue: '#7aa2f7', red: '#f7768e' }],
      ['nord', { foreground: '#d8dee9', blue: '#81a1c1', green: '#a3be8c' }],
      ['github-light', { foreground: '#1f2328', blue: '#0969da', red: '#cf222e' }],
      ['gruvbox-dark', { foreground: '#ebdbb2', green: '#98971a', yellow: '#d79921' }],
    ]) {
      expect(Theme.getTerminalTheme(id), id).toMatchObject(unchanged);
    }
    expect(Theme.getTerminalTheme('tokyo-night').brightBlack).toBe('#414868');
    expect(Theme.getTerminalTheme('nord').red).toBe('#bf616a');
    expect(Theme.getTerminalTheme('gruvbox-dark').blue).toBe('#458588');
    expect(Theme.getTerminalTheme('solarized-light').brightWhite).toBe('#fdf6e3');
    const palette = Theme.getTerminalTheme('deep-current');
    expect(palette.blue).toBe('#7aa2f7');
    expect(palette.cursor).toBe('#edbd8b');
    palette.blue = '#000000';
    expect(Theme.getTerminalTheme('deep-current').blue).toBe('#7aa2f7');
  });

  it('corrects default text and selection contrast while keeping new ANSI palettes readable', () => {
    const Theme = loadTheme();
    const ansi = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
    for (const { id } of Theme.getThemeList()) {
      const palette = Theme.getTerminalTheme(id);
      for (const key of ['foreground', 'cursor', ...(['prism', 'graphite', 'forest-ink', 'oyster'].includes(id) ? ansi : [])]) {
        expect(palette[key], id + '/' + key).toMatch(/^#[0-9a-f]{6}$/i);
        expect(contrastRatio(channels(palette[key]), channels(palette.background)), id + '/' + key)
          .toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(channels(palette.selectionForeground), channels(palette.selectionBackground)), id + '/selection')
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps semantic action text readable in all palettes', () => {
    const Theme = loadTheme();
    for (const { id, colors } of Theme.getThemeList()) {
      for (const color of ['--accent-blue', '--accent-green', '--accent-red', '--accent-yellow', '--accent-purple']) {
        expect(contrastRatio(channels(colors[color]), channels(colors['--bg-primary'])), id + '/' + color)
          .toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps bright text legible on classic ANSI gray backgrounds', () => {
    const Theme = loadTheme();
    for (const id of ['tokyo-night', 'nord', 'solarized-light']) {
      const palette = Theme.getTerminalTheme(id);
      expect(contrastRatio(channels(palette.brightWhite), channels(palette.brightBlack)), id + '/SGR 97;100')
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([false, true])('enables per-cell contrast in terminal mode nozoom=%s', (nozoom) => {
    loadTheme();
    dom.window.state = { currentPane: '%test', currentServer: 'local' };
    dom.window.eval(terminalSource);
    dom.window.Terminal = function (options) { this.options = options; };
    const term = dom.window.createTerminalInstance(120, 40, nozoom);
    expect(term.options.minimumContrastRatio).toBe(4.5);
    expect(term.options.theme.brightBlack).toBe('#414868');
    expect(term.options.macOptionClickForcesSelection).toBe(!nozoom);
  });

  it('keeps picker previews opaque and isolated from native transparency and caller mutations', () => {
    const Theme = loadTheme('prism', { native: true, transparency: '40' });
    const preview = Theme.getThemeList().find(({ id }) => id === 'prism');
    expect(Theme.getTerminalTheme().background).toBe('rgba(0, 0, 0, 0)');
    expect(preview.terminal.background).toBe('#191923');
    preview.terminal.blue = '#000000';
    expect(Theme.getTerminalTheme().blue).toBe('#a6a5f8');
    renderSettings();
    const card = dom.window.document.querySelector('.theme-card[data-theme="prism"]');
    expect(card.querySelector('.theme-card-description').textContent).toContain('烟紫');
    expect(card.querySelectorAll('.theme-card-swatches i')).toHaveLength(6);
    expect(card.querySelectorAll('.theme-card-swatches i')[3].style.background).toBe('rgb(166, 165, 248)');
  });
});

describe('native glass & surface transparency', () => {
  it('only exposes the system glass intensity control on legacy system engine in desktop mode', () => {
    const Theme = loadTheme(null, { native: true, glass: '35' });
    renderSettings();
    Theme.setGlassIntensity(0);
    expect(Theme.supportsGlassIntensity()).toBe(false);
    expect(dom.window.document.getElementById('native-glass-intensity')).toBeNull();
    expect(dom.window.document.getElementById('surface-glassIntensity')).toBeNull();
  });

  it('bounds native glass intensity values before sending them to native', () => {
    const Theme = loadTheme(null, { native: true, appearance: true });
    const send = dom.window.webkit.messageHandlers.anymuxAppearance.postMessage;
    expect(Theme.getGlassIntensity()).toBe(100);
    expect(send).toHaveBeenLastCalledWith({ glassIntensity: 100 });
    for (const [value, expected] of [[0, 0], [34.7, 35], [150, 100], [-10, 0], ['bad', 100]]) {
      Theme.setGlassIntensity(value);
      expect(Theme.getGlassIntensity()).toBe(expected);
      expect(send).toHaveBeenLastCalledWith({ glassIntensity: expected });
    }
  });

  it('renders unified system-engine controls in desktop mode without duplicate legacy blocks', () => {
    const Theme = loadTheme(null, { native: true, appearance: true, glass: '65', transparency: '40' });
    Theme.setSurface({ mode: 'desktop', nativeEngine: 'system', transparency: 40, glassIntensity: 65 });
    renderSettings();
    dom.window.eval(msAppSource);
    dom.window.MsApp._bindEvents();
    expect(dom.window.document.getElementById('native-transparency')).toBeNull();
    expect(dom.window.document.getElementById('native-glass-intensity')).toBeNull();

    const transSlider = dom.window.document.getElementById('surface-transparency');
    const glassSlider = dom.window.document.getElementById('surface-glassIntensity');
    const glassOutput = dom.window.document.getElementById('surface-glassIntensity-value');
    const send = dom.window.webkit.messageHandlers.anymuxAppearance.postMessage;

    expect([transSlider.min, transSlider.max, transSlider.value]).toEqual(['0', '50', '40']);
    expect([glassSlider.min, glassSlider.max, glassSlider.value]).toEqual(['0', '100', '65']);

    glassSlider.value = '25';
    glassSlider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(glassOutput.textContent).toBe('25%');
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ glassIntensity: 25, mode: 'desktop', engine: 'system' }));
    expect(Theme.getTransparency()).toBe(40);
  });
});

describe('native window transparency', () => {
  it.each([false, true])('keeps unsupported clients opaque with saved preferences (legacy native: %s)', (legacyNative) => {
    const Theme = loadTheme('prism', { transparency: '35', legacyNative });
    const root = dom.window.document.documentElement;
    renderSettings();

    Theme.setTransparency(50);
    expect(Theme.supportsTransparency()).toBe(false);
    expect(Theme.getTransparency()).toBe(0);
    expect(Theme.getTerminalTheme().background).toBe('#191923');
    expect(root.hasAttribute('data-native-transparency')).toBe(false);
    expect(dom.window.document.getElementById('surface-transparency')).toBeNull();
    expect(dom.window.document.querySelector('[data-action="set-surface-mode"][data-mode="desktop"]')).toBeNull();
  });

  it('defaults to opaque and persists only a bounded integer percentage in anymux_appearance_v4', () => {
    const Theme = loadTheme(null, { native: true });
    const changed = vi.fn();
    dom.window.document.addEventListener('tmux-transparency-change', changed);

    expect(Theme.supportsTransparency()).toBe(true);
    expect(Theme.getTransparency()).toBe(0);
    for (const [input, expected] of [[27.6, 28], [90, 50], [-10, 0], ['invalid', 0]]) {
      Theme.setTransparency(input);
      expect(Theme.getTransparency()).toBe(expected);
      expect(JSON.parse(dom.window.localStorage.getItem('anymux_appearance_v4')).surfaces.native.transparency).toBe(expected);
      expect(dom.window.document.documentElement.hasAttribute('data-native-transparency')).toBe(expected > 0);
    }
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it('restores transparency and keeps palette colors intact across theme changes', () => {
    const Theme = loadTheme('prism', { native: true, transparency: '25' });
    const root = dom.window.document.documentElement;

    expect(Theme.getTransparency()).toBe(25);
    expect(root.style.getPropertyValue('--native-window-background')).toBe('rgba(25, 25, 35, 0.75)');
    expect(Theme.getTerminalTheme().background).toBe('rgba(0, 0, 0, 0)');

    Theme.apply('github-light');
    const transparentPalette = Theme.getTerminalTheme();
    expect(Theme.getTransparency()).toBe(25);
    expect(root.style.getPropertyValue('--native-window-background')).toBe('rgba(255, 255, 255, 0.75)');
    expect(root.style.getPropertyValue('--bg-primary')).toBe('#ffffff');

    Theme.setTransparency(0);
    expect(Theme.getTerminalTheme()).toEqual({ ...transparentPalette, background: '#ffffff' });
    expect(root.hasAttribute('data-native-transparency')).toBe(false);
  });

  it('updates mounted terminals when preferences change locally or via cross-tab v3 storage', () => {
    const Theme = loadTheme(null, { native: true });
    dom.window.eval(terminalSource);
    const term = { options: { theme: Theme.getTerminalTheme() } };
    dom.window.terminalState.term = term;

    Theme.setTransparency(30);
    expect(term.options.theme.background).toBe('rgba(0, 0, 0, 0)');

    const snap = Theme.getSnapshot();
    snap.themes.native.themeId = 'prism';
    snap.surfaces.native.transparency = 15;
    storageChange('anymux_appearance_v4', JSON.stringify(snap));
    expect(dom.window.document.documentElement.getAttribute('data-theme')).toBe('prism');
    expect(term.options.theme.foreground).toBe('#e8e5f2');
    expect(Theme.getTransparency()).toBe(15);
    expect(dom.window.document.documentElement.style.getPropertyValue('--native-window-background'))
      .toBe('rgba(25, 25, 35, 0.85)');

    storageChange(null, null);
    expect(Theme.getTransparency()).toBe(0);
    expect(term.options.theme.background).toBe('#1a1b26');
  });

  it('renders an accessible native transparency slider under desktop mode and applies input immediately', () => {
    const Theme = loadTheme(null, { native: true, transparency: '20', engine: 'material', appearance: true });
    renderSettings();
    dom.window.eval(msAppSource);
    dom.window.MsApp._bindEvents();
    const slider = dom.window.document.getElementById('surface-transparency');
    const output = dom.window.document.getElementById('surface-transparency-value');

    expect(slider.type).toBe('range');
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual(['0', '50', '1', '20']);
    expect(slider.labels[0].textContent).toBe('窗口透明度');
    expect(output.textContent).toBe('20%');

    slider.value = '35';
    slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    expect(Theme.getTransparency()).toBe(35);
    expect(output.textContent).toBe('35%');
    expect(dom.window.document.documentElement.hasAttribute('data-native-transparency')).toBe(true);
  });

  it('keeps left and right sidebars transparent under native transparency', () => {
    const workspaceCss = readFileSync('plugins/ui/client/css/workspace.css', 'utf8');
    const previewWorkspaceCss = readFileSync('plugins/files/client/css/file-preview-workspace.css', 'utf8');

    expect(workspaceCss).toContain('html[data-native-transparency] .workspace-chrome .brand { background:transparent; }');
    expect(workspaceCss).toContain(
      'html[data-native-transparency] .ms-app .ms-sidebar .sidebar-footer,html[data-native-transparency] .ms-app.sidebar-collapsed .ms-sidebar .sidebar-footer { background:transparent; }',
    );
    expect(previewWorkspaceCss).toMatch(/html\[data-native-transparency\] \.fp-overlay\.fp-side:not\(\.fp-side-maximized\)/);
    expect(previewWorkspaceCss).toMatch(/html\[data-native-transparency\] \.fp-dock \.fp-dock-tab-item\.active/);
    expect(previewWorkspaceCss).toMatch(/html\[data-native-transparency\] \.fp-dock \.fp-embedded/);

    loadTheme('tokyo-night', { native: true, transparency: '25' });
    const doc = dom.window.document;
    const style = doc.createElement('style');
    const concreteCss = (workspaceCss + '\n' + previewWorkspaceCss)
      .replace(/color-mix\((?:[^()]|\([^()]*\))*\)/g, '#16161e')
      .replace(/var\(--fp-bg(?:,[^)]+)?\)/g, '#1a1b26')
      .replace(/var\(--fp-panel(?:,[^)]+)?\)/g, '#24283b')
      .replace(/var\(--workspace-bg(?:,[^)]+)?\)/g, '#1a1b26')
      .replace(/var\(--workspace-sidebar(?:,[^)]+)?\)/g, '#16161e')
      .replace(/var\(--workspace-panel(?:,[^)]+)?\)/g, '#24283b')
      .replace(/var\(--workspace-[a-z-]+(?:,[^)]+)?\)/g, '#2f3450')
      .replace(/var\(--fp-[a-z-]+(?:,[^)]+)?\)/g, '#2f3450');
    style.textContent = concreteCss;
    doc.head.appendChild(style);

    doc.body.innerHTML = `
      <div class="ms-app sidebar-collapsed mode-terminal">
        <header class="workspace-chrome"><div class="brand"></div></header>
        <aside class="ms-sidebar"><div class="sidebar-footer"></div></aside>
        <main class="ms-main">
          <div class="fp-overlay fp-side fp-dock">
            <div class="fp-modal">
              <div class="fp-dock-tabs">
                <div class="fp-dock-tab-item active"></div>
              </div>
              <div class="fp-embedded"></div>
            </div>
          </div>
        </main>
      </div>
    `;

    const targets = [
      doc.querySelector('.workspace-chrome .brand'),
      doc.querySelector('.ms-sidebar .sidebar-footer'),
      doc.querySelector('.fp-overlay.fp-side.fp-dock'),
      doc.querySelector('.fp-dock .fp-modal'),
      doc.querySelector('.fp-dock .fp-dock-tab-item.active'),
      doc.querySelector('.fp-dock .fp-embedded'),
    ];
    for (const el of targets) {
      expect(dom.window.getComputedStyle(el).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    }

    doc.documentElement.removeAttribute('data-native-transparency');
    expect(dom.window.getComputedStyle(doc.querySelector('.fp-overlay.fp-side.fp-dock')).backgroundColor).toBe('rgb(26, 27, 38)');
    expect(dom.window.getComputedStyle(doc.querySelector('.ms-sidebar .sidebar-footer')).backgroundColor).toBe('rgb(22, 22, 30)');
    expect(dom.window.getComputedStyle(doc.querySelector('.workspace-chrome .brand')).backgroundColor).toBe('rgb(22, 22, 30)');
  });
});

describe('wallpapers, glass engine, auto scheme, custom themes & typography', () => {
  it('exposes 12 built-in wallpapers and resolves theme-matched wallpapers automatically', () => {
    const Theme = loadTheme('tokyo-night');
    const wallpapers = Theme.getBuiltInWallpapers();
    expect(wallpapers).toHaveLength(12);
    for (const theme of Theme.getThemeList()) {
      expect(wallpapers.some((w) => w.id === theme.defaultWallpaper)).toBe(true);
    }

    Theme.setWallpaper({ mode: 'builtin', followTheme: true });
    const root = dom.window.document.documentElement;
    expect(Theme.isWallpaperActive()).toBe(true);
    expect(Theme.isBackdropActive()).toBe(true);
    expect(Theme.getResolvedWallpaperUrl()).toBe('/wallpapers/tokyo-night-skyline.webp');
    expect(root.hasAttribute('data-wallpaper-active')).toBe(true);
    expect(root.hasAttribute('data-backdrop-active')).toBe(true);
    expect(Theme.getTerminalTheme().background).toBe('rgba(0, 0, 0, 0)');
    const backdrop = dom.window.document.getElementById('anymux-wallpaper-backdrop');
    expect(backdrop).not.toBeNull();
    expect(backdrop.hidden).toBe(false);
    expect(backdrop.querySelector('.anymux-wp-image').style.backgroundImage).toContain('/wallpapers/tokyo-night-skyline.webp');

    Theme.apply('oyster');
    expect(Theme.getResolvedWallpaperUrl()).toBe('/wallpapers/oyster-dune.webp');
    expect(backdrop.querySelector('.anymux-wp-image').style.backgroundImage).toContain('/wallpapers/oyster-dune.webp');

    Theme.apply('tokyo-night');
    Theme.setWallpaper({ mode: 'builtin', id: 'nord-fjord' });
    expect(Theme.getWallpaper().followTheme).toBe(false);
    expect(Theme.getResolvedWallpaperUrl()).toBe('/wallpapers/nord-fjord.webp');

    Theme.setWallpaper({ mode: 'none' });
    expect(Theme.isWallpaperActive()).toBe(false);
    expect(backdrop.hidden).toBe(true);
    expect(Theme.getTerminalTheme().background).toBe('#1a1b26');
  });

  it('applies glass presets, fine CSS variables, and rich native Material/Liquid Glass payloads', () => {
    dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      url: 'https://anymux.test/',
    });
    dom.window.__anymuxTransparency = true;
    dom.window.__anymuxGlassEngine = 'material';
    dom.window.__anymuxLiquidGlass = true;
    const postMessage = vi.fn();
    dom.window.webkit = { messageHandlers: { anymuxAppearance: { postMessage } } };
    dom.window.eval(themeSource);
    const Theme = dom.window.Theme;

    expect(Theme.supportsMaterialEngine()).toBe(true);
    expect(Theme.supportsLiquidGlass()).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      engine: 'material',
      mode: 'none',
      colorScheme: 'dark',
    }));

    Theme.setSurface({ mode: 'desktop', nativeEngine: 'liquid-regular', transparency: 38, blurRadius: 34, saturation: 155 });
    expect(Theme.getWallpaper().mode).toBe('desktop');
    expect(Theme.getGlass().nativeEngine).toBe('liquid-regular');
    expect(Theme.getTransparency()).toBe(38);
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: 'desktop',
      engine: 'liquid-regular',
      blurRadius: 34,
      saturation: 1.55,
    }));

    Theme.setGlass({ blurRadius: 40, noiseOpacity: 12, inactivePaneDim: 30 });
    const root = dom.window.document.documentElement;
    expect(root.style.getPropertyValue('--anymux-wp-blur')).toBe('40px');
    expect(root.style.getPropertyValue('--anymux-wp-noise-opacity')).toBe('0.120');
    expect(root.style.getPropertyValue('--anymux-pane-inactive-dim')).toBe('30%');
  });

  it('renders contextual zero-dead-control UI per surface mode, isolates 3 device slots, and supports zero-write preview', async () => {
    const Theme = loadTheme('tokyo-night');
    renderSettings();

    // Default mode is solid -> NO wallpaper grid, NO presets, NO blur sliders!
    expect(dom.window.document.getElementById('appearance-live-preview')).not.toBeNull();
    expect(dom.window.document.querySelector('.wallpaper-grid')).toBeNull();
    expect(dom.window.document.querySelector('.glass-preset-chip')).toBeNull();
    expect(dom.window.document.getElementById('surface-blurRadius')).toBeNull();
    // Card 3 inline vs collapsed details
    expect(dom.window.document.getElementById('typo-fontSize')).not.toBeNull();
    const termFine = dom.window.document.querySelector('[data-disclosure="terminal-fine"]');
    expect(termFine.open).toBe(false);
    expect(dom.window.document.getElementById('typo-inactivePaneDim')).not.toBeNull();

    // Switch to wallpaper mode -> renders follow-theme + 12 built-ins + 3 Web presets + collapsed fine controls
    Theme.setSurface({ mode: 'wallpaper' });
    renderSettings();
    expect(dom.window.document.querySelectorAll('.wallpaper-card').length).toBe(13);
    expect(dom.window.document.querySelectorAll('.glass-preset-chip').length).toBe(3);
    expect(dom.window.document.getElementById('surface-transparency')).toBeNull();
    // Apply Web preset must NOT remove wallpaper
    Theme.applyWebPreset('mist');
    expect(Theme.getSurface().mode).toBe('wallpaper');
    expect(Theme.getSurface().webPreset).toBe('mist');
    expect(Theme.getSurface().blurRadius).toBe(14);

    // Zero-side-effect previewTheme / clearPreview preserves system mode & does not persist
    Theme.setLightThemeId('oyster');
    Theme.setDarkThemeId('tokyo-night');
    Theme.setThemeMode('system');
    const savedBefore = dom.window.localStorage.getItem('anymux_appearance_v4');
    Theme.previewTheme('github-light');
    expect(dom.window.document.documentElement.getAttribute('data-theme')).toBe('github-light');
    expect(Theme.getThemeMode()).toBe('system');
    expect(dom.window.localStorage.getItem('anymux_appearance_v4')).toBe(savedBefore);
    Theme.clearPreview();
    expect(dom.window.document.documentElement.getAttribute('data-theme')).toBe('tokyo-night');

    // Syncing a remote config with desktop mode on native does NOT clobber web slot
    const snap = Theme.getSnapshot();
    snap.themes.web.updatedAt = Date.now() + 60000;
    snap.themes.web.mode = 'manual';
    snap.themes.web.themeId = 'nord';
    snap.surfaces.native.updatedAt = Date.now() + 60000;
    snap.surfaces.native.mode = 'desktop';
    snap.surfaces.native.transparency = 35;
    snap.surfaces.web.updatedAt = Date.now() + 60000;
    snap.surfaces.web.mode = 'wallpaper';
    snap.surfaces.web.wallpaperSource = 'builtin';
    snap.surfaces.web.wallpaperId = 'nord-fjord';
    dom.window.Api = {
      get: vi.fn(async () => ({ config: snap, customWallpapers: [] })),
      put: vi.fn(async () => ({})),
    };
    await Theme.syncFromServer();
    expect(Theme.getCurrent()).toBe('nord');
    expect(Theme.getDeviceProfileKey()).toBe('web');
    expect(Theme.getSurface().mode).toBe('wallpaper');
    expect(Theme.getSurface().wallpaperId).toBe('nord-fjord');
  });

  it('switches automatically between light and dark themes when system color scheme changes', () => {
    dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      url: 'https://anymux.test/',
    });
    let lightMatches = false;
    const listeners = [];
    dom.window.matchMedia = vi.fn((query) => ({
      get matches() { return String(query).includes('prefers-color-scheme') ? lightMatches : false; },
      addEventListener: (_evt, cb) => listeners.push(cb),
    }));
    dom.window.eval(themeSource);
    const Theme = dom.window.Theme;

    Theme.setLightThemeId('github-light');
    Theme.setDarkThemeId('nord');
    Theme.setThemeMode('system');
    expect(Theme.getCurrent()).toBe('nord');

    lightMatches = true;
    listeners.forEach((cb) => cb({ matches: true }));
    expect(Theme.getCurrent()).toBe('github-light');
    expect(dom.window.document.documentElement.getAttribute('data-theme')).toBe('github-light');
  });

  it('enforces WCAG contrast on custom accent overrides and supports custom theme JSON import/export/delete', () => {
    const Theme = loadTheme('tokyo-night');
    Theme.setAccentOverride('#1d1e2b');
    const accent = dom.window.document.documentElement.style.getPropertyValue('--workspace-accent');
    const bg = dom.window.document.documentElement.style.getPropertyValue('--workspace-bg');
    expect(contrastRatio(channels(accent), channels(bg))).toBeGreaterThanOrEqual(4.5);

    const imported = Theme.importThemeJson(JSON.stringify({
      name: 'Midnight Jade',
      terminal: {
        background: '#0f1715',
        foreground: '#dbeae4',
        blue: '#4fd1c5',
        green: '#68d391',
      },
    }));
    expect(imported.id).toBe('custom-midnight-jade');
    expect(Theme.getCurrent()).toBe('custom-midnight-jade');
    expect(Theme.getThemeList().some((t) => t.id === 'custom-midnight-jade')).toBe(true);

    const exported = JSON.parse(Theme.exportThemeJson('custom-midnight-jade'));
    expect(exported.name).toBe('Midnight Jade');
    expect(exported.ui['--workspace-bg']).toBe('#0f1715');

    expect(Theme.deleteCustomTheme('custom-midnight-jade')).toBe(true);
    expect(Theme.getCurrent()).toBe('tokyo-night');
  });

  it('bounds terminal typography, syncs with server timestamps, and renders upgraded appearance settings', async () => {
    const Theme = loadTheme('tokyo-night');
    const typoListener = vi.fn();
    dom.window.document.addEventListener('tmux-typography-change', typoListener);
    Theme.setTerminalTypography({ fontSize: 16, lineHeight: 1.45, cursorStyle: 'bar', cursorBlink: false, panePadding: 10 });
    expect(typoListener).toHaveBeenCalledOnce();
    expect(Theme.getTerminalTypography()).toEqual({
      fontSize: 16,
      lineHeight: 1.45,
      cursorStyle: 'bar',
      cursorBlink: false,
      panePadding: 10,
      inactivePaneDim: 18,
    });
    expect(dom.window.document.documentElement.style.getPropertyValue('--terminal-pane-padding')).toBe('10px');

    const remoteConfig = Theme.getSnapshot();
    remoteConfig.updatedAt = Date.now() + 60000;
    remoteConfig.themes.web.updatedAt = remoteConfig.updatedAt;
    remoteConfig.themes.web.themeId = 'nord';
    remoteConfig.surfaces.web.updatedAt = remoteConfig.updatedAt;
    remoteConfig.surfaces.web.mode = 'wallpaper';
    remoteConfig.surfaces.web.wallpaperSource = 'follow';
    remoteConfig.surfaces.web.wallpaperBrightness = 92;
    dom.window.Api = {
      get: vi.fn(async () => ({ config: remoteConfig, customWallpapers: [] })),
      put: vi.fn(async () => ({})),
    };
    await Theme.syncFromServer();
    expect(Theme.getCurrent()).toBe('nord');
    expect(Theme.getWallpaper().mode).toBe('builtin');

    renderSettings();
    expect(dom.window.document.querySelectorAll('.wallpaper-card').length).toBeGreaterThanOrEqual(13);
    expect(dom.window.document.querySelectorAll('.glass-preset-chip').length).toBe(3);
    expect(dom.window.document.getElementById('typo-fontSize')).not.toBeNull();
  });

  it('isolates theme state per device profile across web, native, and Android mobile', async () => {
    const ThemeWeb = loadTheme('nord');
    const putWeb = vi.fn(async () => ({}));
    const remoteForWeb = ThemeWeb.getSnapshot();
    remoteForWeb.themes.mobile = { updatedAt: Date.now() + 60000, mode: 'manual', themeId: 'oyster', lightThemeId: 'oyster', darkThemeId: 'tokyo-night', accentOverride: null };
    dom.window.Api = {
      get: vi.fn(async () => ({ config: remoteForWeb, customWallpapers: [] })),
      put: putWeb,
    };
    await ThemeWeb.syncFromServer();
    // Newer mobile theme on server does NOT alter web theme.
    expect(ThemeWeb.getCurrent()).toBe('nord');

    ThemeWeb.apply('prism');
    await ThemeWeb.saveToServer();
    expect(putWeb).toHaveBeenCalledOnce();
    const sentWeb = putWeb.mock.calls[0][1];
    expect(Object.keys(sentWeb.themes)).toEqual(['web']);
    expect(Object.keys(sentWeb.surfaces)).toEqual(['web']);
    expect(sentWeb.themes.web.themeId).toBe('prism');

    dom.window.close();
    dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      url: 'https://anymux.test/',
    });
    Object.defineProperty(dom.window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 AnymuxAndroid/1.0',
      configurable: true,
    });
    // Seed a legacy v3 key to verify migration only stamps mobile.updatedAt and never pushes web/native.
    dom.window.localStorage.setItem('anymux_appearance_v3', JSON.stringify({
      version: 3,
      updatedAt: 5000,
      themeUpdatedAt: 5000,
      theme: { mode: 'manual', themeId: 'oyster', lightThemeId: 'oyster', darkThemeId: 'tokyo-night', accentOverride: null, customThemes: [] },
      surfaces: { mobile: { updatedAt: 5000, mode: 'solid' } },
    }));
    dom.window.eval(themeSource);
    const ThemeAndroid = dom.window.Theme;
    expect(ThemeAndroid.getDeviceProfileKey()).toBe('mobile');
    expect(ThemeAndroid.getCurrent()).toBe('oyster');
    const snapAndroid = ThemeAndroid.getSnapshot();
    expect(snapAndroid.themes.mobile.updatedAt).toBe(5000);
    expect(snapAndroid.themes.web.updatedAt).toBe(0);
    expect(snapAndroid.themes.native.updatedAt).toBe(0);

    const putMobile = vi.fn(async () => ({}));
    const remoteForMobile = ThemeAndroid.getSnapshot();
    remoteForMobile.themes.mobile.updatedAt = 0;
    remoteForMobile.themes.web = { updatedAt: 9999999, mode: 'manual', themeId: 'forest-ink', lightThemeId: 'oyster', darkThemeId: 'tokyo-night', accentOverride: null };
    remoteForMobile.themes.native = { updatedAt: 9999999, mode: 'manual', themeId: 'prism', lightThemeId: 'oyster', darkThemeId: 'tokyo-night', accentOverride: null };
    dom.window.Api = {
      get: vi.fn(async () => ({ config: remoteForMobile, customWallpapers: [] })),
      put: putMobile,
    };
    await ThemeAndroid.syncFromServer();
    expect(ThemeAndroid.getCurrent()).toBe('oyster');
    expect(putMobile).toHaveBeenCalledOnce();
    const sentMobile = putMobile.mock.calls[0][1];
    expect(Object.keys(sentMobile.themes)).toEqual(['mobile']);
    expect(Object.keys(sentMobile.surfaces)).toEqual(['mobile']);

    // Non-persisting apply must not mutate storage or schedule server save.
    const storedBefore = dom.window.localStorage.getItem('anymux_appearance_v4');
    putMobile.mockClear();
    ThemeAndroid.apply('graphite', { persist: false, sync: false });
    expect(dom.window.document.documentElement.getAttribute('data-theme')).toBe('graphite');
    expect(dom.window.localStorage.getItem('anymux_appearance_v4')).toBe(storedBefore);
    expect(putMobile).not.toHaveBeenCalled();
  });
});
