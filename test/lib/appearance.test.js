import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from 'cordis';
import { afterEach, describe, expect, it } from 'vitest';
import { AppearanceStore, DEFAULT_APPEARANCE, detectImageFormat, sanitizeAppearanceConfig, validateCustomTheme } from '../../lib/appearance.js';
import HttpService from '../../plugins/http/index.js';
import UiService from '../../plugins/ui/index.js';

const cleanupDirs = [];
const cleanupFibers = [];

afterEach(async () => {
  for (const fiber of cleanupFibers.splice(0)) await fiber.dispose();
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'anymux-appearance-'));
  cleanupDirs.push(dir);
  return dir;
}

const VALID_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

const VALID_WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.from('VP8 '),
]);

describe('appearance config & store v4', () => {
  it('sanitizes v4 domain config, enforces device surface modes, and clamps values safely', () => {
    const clean = sanitizeAppearanceConfig({
      customThemesUpdatedAt: 900,
      terminalUpdatedAt: 2000,
      themes: {
        native: {
          updatedAt: 1000,
          mode: 'system',
          themeId: 'invalid id!',
          lightThemeId: 'github-light',
          darkThemeId: 'nord',
          accentOverride: ' #7AA2F7 ',
        },
        web: {
          updatedAt: 1200,
          mode: 'manual',
          themeId: 'prism',
          lightThemeId: 'oyster',
          darkThemeId: 'nord',
          accentOverride: 'not-a-hex',
        },
        mobile: {
          updatedAt: 1500,
          mode: 'manual',
          themeId: 'oyster',
        },
      },
      terminal: {
        fontSize: 40,
        lineHeight: 2.5,
        cursorStyle: 'bar',
        cursorBlink: false,
        panePadding: 30,
        inactivePaneDim: 99,
      },
      surfaces: {
        native: {
          updatedAt: 3000,
          mode: 'desktop',
          nativeEngine: 'liquid-clear',
          transparency: 99,
          glassIntensity: -5,
          blurRadius: 100,
          saturation: 300,
        },
        web: {
          updatedAt: 2500,
          mode: 'desktop', // forbidden on web; coerces to solid
          transparency: 40, // coerced to 0 on web
          wallpaperSource: 'follow',
          wallpaperId: 'nord-fjord', // cleared because wallpaperSource === 'follow' & mode !== wallpaper
          webPreset: 'clear',
          blurRadius: 80,
          sidebarTint: 99,
          terminalTint: 5,
        },
        mobile: {
          updatedAt: 2200,
          mode: 'wallpaper',
          wallpaperSource: 'builtin',
          wallpaperId: 'oyster-dune',
          wallpaperFit: 'contain',
          wallpaperBrightness: 250,
          noiseOpacity: 50,
        },
      },
    });

    expect(clean.version).toBe(4);
    expect(clean.updatedAt).toBe(3000);
    expect(clean.themes.native).toMatchObject({
      updatedAt: 1000,
      mode: 'system',
      themeId: DEFAULT_APPEARANCE.themes.native.themeId,
      lightThemeId: 'github-light',
      darkThemeId: 'nord',
      accentOverride: '#7aa2f7',
    });
    expect(clean.themes.web).toMatchObject({
      updatedAt: 1200,
      mode: 'manual',
      themeId: 'prism',
      accentOverride: null,
    });
    expect(clean.themes.mobile).toMatchObject({
      updatedAt: 1500,
      mode: 'manual',
      themeId: 'oyster',
    });
    expect(clean.terminal).toEqual({
      fontSize: 22,
      lineHeight: 1.8,
      cursorStyle: 'bar',
      cursorBlink: false,
      panePadding: 16,
      inactivePaneDim: 45,
    });
    expect(clean.surfaces.native).toMatchObject({
      mode: 'desktop',
      nativeEngine: 'liquid-clear',
      transparency: 50,
      glassIntensity: 0,
      blurRadius: 48,
      saturation: 200,
    });
    expect(clean.surfaces.web).toMatchObject({
      mode: 'solid',
      transparency: 0,
      wallpaperId: null,
      webPreset: 'clear',
      blurRadius: 48,
      sidebarTint: 85,
      terminalTint: 20,
    });
    expect(clean.surfaces.mobile).toMatchObject({
      mode: 'wallpaper',
      wallpaperSource: 'builtin',
      wallpaperId: 'oyster-dune',
      wallpaperFit: 'contain',
      wallpaperBrightness: 130,
      noiseOpacity: 18,
    });
  });

  it('migrates legacy v2 flat config and v3 config to v4 without leaking desktop mode to web/mobile', () => {
    const migratedV2 = sanitizeAppearanceConfig({
      version: 2,
      updatedAt: 5555,
      themeMode: 'system',
      themeId: 'nord',
      wallpaper: { mode: 'desktop', id: null, followTheme: true, fit: 'cover', brightness: 100 },
      glass: { preset: 'liquid', nativeEngine: 'liquid-regular', transparency: 32, blurRadius: 34, inactivePaneDim: 24 },
      typography: { fontSize: 16, lineHeight: 1.4, cursorStyle: 'underline', cursorBlink: false, panePadding: 8 },
    });

    expect(migratedV2.version).toBe(4);
    expect(migratedV2.themes.native).toMatchObject({ mode: 'system', themeId: 'nord' });
    expect(migratedV2.themes.web).toMatchObject({ mode: 'system', themeId: 'nord' });
    expect(migratedV2.themes.mobile).toMatchObject({ mode: 'system', themeId: 'nord' });
    expect(migratedV2.terminal).toEqual({
      fontSize: 16,
      lineHeight: 1.4,
      cursorStyle: 'underline',
      cursorBlink: false,
      panePadding: 8,
      inactivePaneDim: 24,
    });
    expect(migratedV2.surfaces.native.mode).toBe('desktop');
    expect(migratedV2.surfaces.native.transparency).toBe(32);
    expect(migratedV2.surfaces.web.mode).toBe('solid');
    expect(migratedV2.surfaces.web.transparency).toBe(0);
    expect(migratedV2.surfaces.mobile.mode).toBe('solid');

    const migratedV3 = sanitizeAppearanceConfig({
      version: 3,
      updatedAt: 7000,
      themeUpdatedAt: 6500,
      terminalUpdatedAt: 6200,
      theme: {
        mode: 'manual',
        themeId: 'forest-ink',
        lightThemeId: 'oyster',
        darkThemeId: 'tokyo-night',
        accentOverride: '#baca84',
        customThemes: [{ name: 'Jade', background: '#101815', foreground: '#e2ece7' }],
      },
      surfaces: {
        native: { updatedAt: 6500, mode: 'desktop', transparency: 28 },
      },
    });
    expect(migratedV3.version).toBe(4);
    expect(migratedV3.customThemesUpdatedAt).toBe(6500);
    expect(migratedV3.customThemes).toHaveLength(1);
    expect(migratedV3.themes.native).toMatchObject({ updatedAt: 6500, themeId: 'forest-ink', accentOverride: '#baca84' });
    expect(migratedV3.themes.web).toMatchObject({ updatedAt: 6500, themeId: 'forest-ink', accentOverride: '#baca84' });
    expect(migratedV3.themes.mobile).toMatchObject({ updatedAt: 6500, themeId: 'forest-ink', accentOverride: '#baca84' });
    expect(migratedV3.surfaces.native.mode).toBe('desktop');
  });

  it('merges per-device theme and surface timestamps independently and ignores stale v3 payloads once v4 is initialized', () => {
    const existing = sanitizeAppearanceConfig({
      themes: {
        native: { updatedAt: 400, themeId: 'prism' },
        web: { updatedAt: 200, themeId: 'nord' },
        mobile: { updatedAt: 100, themeId: 'tokyo-night' },
      },
      surfaces: {
        native: { updatedAt: 500, mode: 'desktop', transparency: 30 },
        web: { updatedAt: 100, mode: 'solid' },
      },
    });
    const merged = sanitizeAppearanceConfig({
      themes: {
        native: { updatedAt: 150, themeId: 'oyster' }, // stale -> keep prism
        mobile: { updatedAt: 300, themeId: 'github-light' }, // newer -> update mobile only
      },
      surfaces: {
        native: { updatedAt: 200, mode: 'solid', transparency: 0 }, // stale -> keep desktop
        web: { updatedAt: 400, mode: 'wallpaper', wallpaperSource: 'builtin', wallpaperId: 'nord-fjord' }, // newer -> accept
      },
    }, existing);

    expect(merged.themes.native.themeId).toBe('prism');
    expect(merged.themes.web.themeId).toBe('nord');
    expect(merged.themes.mobile.themeId).toBe('github-light');
    expect(merged.surfaces.native.mode).toBe('desktop');
    expect(merged.surfaces.native.transparency).toBe(30);
    expect(merged.surfaces.web.mode).toBe('wallpaper');
    expect(merged.surfaces.web.wallpaperId).toBe('nord-fjord');

    // A stale v3 client payload with a high themeUpdatedAt must NOT fan out over initialized v4 themes.
    const afterStaleV3 = sanitizeAppearanceConfig({
      version: 3,
      updatedAt: 99999,
      themeUpdatedAt: 99999,
      theme: {
        mode: 'manual',
        themeId: 'oyster',
        customThemes: [],
      },
      surfaces: {
        mobile: { updatedAt: 600, mode: 'wallpaper', wallpaperSource: 'follow' },
      },
    }, merged);

    expect(afterStaleV3.themes.native.themeId).toBe('prism');
    expect(afterStaleV3.themes.web.themeId).toBe('nord');
    expect(afterStaleV3.themes.mobile.themeId).toBe('github-light');
    expect(afterStaleV3.surfaces.mobile.mode).toBe('wallpaper');
  });

  it('resets only profiles referencing a deleted custom theme while preserving other profiles', () => {
    const custom = { id: 'custom-jade', name: 'Jade', background: '#101815', foreground: '#e2ece7' };
    const base = sanitizeAppearanceConfig({
      customThemesUpdatedAt: 1000,
      customThemes: [custom],
      themes: {
        native: { updatedAt: 1000, themeId: 'custom-jade' },
        web: { updatedAt: 1000, themeId: 'nord' },
        mobile: { updatedAt: 1000, mode: 'system', lightThemeId: 'custom-jade', darkThemeId: 'prism' },
      },
    });
    const afterDelete = sanitizeAppearanceConfig({
      customThemesUpdatedAt: 2000,
      customThemes: [],
    }, base);

    expect(afterDelete.customThemes).toEqual([]);
    expect(afterDelete.themes.native.themeId).toBe('tokyo-night');
    expect(afterDelete.themes.native.updatedAt).toBe(2000);
    expect(afterDelete.themes.web.themeId).toBe('nord');
    expect(afterDelete.themes.web.updatedAt).toBe(1000);
    expect(afterDelete.themes.mobile.lightThemeId).toBe('oyster');
    expect(afterDelete.themes.mobile.darkThemeId).toBe('prism');
    expect(afterDelete.themes.mobile.updatedAt).toBe(2000);
  });

  it('detects magic bytes only for safe raster images and rejects SVG/HTML', () => {
    expect(detectImageFormat(VALID_PNG)).toEqual({ ext: 'png', mime: 'image/png' });
    expect(detectImageFormat(VALID_WEBP)).toEqual({ ext: 'webp', mime: 'image/webp' });
    expect(detectImageFormat(Buffer.from('<svg onload="alert(1)"></svg>'))).toBeNull();
    expect(detectImageFormat(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
  });

  it('validates both full and terminal-only custom theme JSON', () => {
    const terminalOnly = validateCustomTheme({
      name: 'Sunset Mono',
      background: '#1E1B2E',
      foreground: '#E8E3F5',
      blue: '#7AA2F7',
    });
    expect(terminalOnly).toMatchObject({
      id: 'custom-sunset-mono',
      name: 'Sunset Mono',
      terminal: { background: '#1e1b2e', foreground: '#e8e3f5', blue: '#7aa2f7' },
    });
    expect(validateCustomTheme({ name: 'Broken', background: 'javascript:alert(1)' })).toBeNull();
  });

  it('persists config, uploads wallpapers, rejects traversal, and resets matching slots on delete', async () => {
    const dir = makeTempDir();
    const store = new AppearanceStore(dir);
    await store.updateConfig({ themes: { web: { updatedAt: 12345, themeId: 'prism' } } });

    const uploaded = await store.saveWallpaper(VALID_PNG, '../../evil.png');
    expect(uploaded.id).toMatch(/^wp-[a-f0-9]{16}\.png$/);
    expect(uploaded.mime).toBe('image/png');
    await store.updateConfig({
      surfaces: {
        web: { updatedAt: 12346, mode: 'wallpaper', wallpaperSource: 'custom', wallpaperId: uploaded.id },
        native: { updatedAt: 12346, mode: 'desktop', transparency: 25 },
      },
    });

    const reloaded = new AppearanceStore(dir);
    await reloaded.ready();
    expect(reloaded.getConfig().themes.web.themeId).toBe('prism');
    expect(reloaded.getConfig().themes.mobile.themeId).toBe('tokyo-night');
    expect(reloaded.getConfig().surfaces.web).toMatchObject({ mode: 'wallpaper', wallpaperSource: 'custom', wallpaperId: uploaded.id });
    expect(reloaded.getConfig().surfaces.native.mode).toBe('desktop');
    expect(await reloaded.listWallpapers()).toHaveLength(1);
    expect(await reloaded.resolveWallpaperFile('../secret.png')).toBeNull();
    expect(await reloaded.resolveWallpaperFile(uploaded.id)).toMatchObject({ id: uploaded.id, mime: 'image/png' });

    expect(await reloaded.deleteWallpaper(uploaded.id)).toBe(true);
    expect(await reloaded.listWallpapers()).toHaveLength(0);
    expect(reloaded.getConfig().surfaces.web).toMatchObject({ mode: 'solid', wallpaperSource: 'follow', wallpaperId: null });
    expect(reloaded.getConfig().surfaces.native.mode).toBe('desktop');
  });
});

describe('/api/appearance HTTP routes', () => {
  async function startUiServer() {
    const dir = makeTempDir();
    const ctx = new Context();
    ctx.provide('launch', { host: '127.0.0.1', port: 0, tls: null, httpPort: null, managedRuntime: false, configDir: dir });
    const http = ctx.plugin(HttpService, { port: 0 });
    await http;
    cleanupFibers.push(http);
    await ctx.plugin(UiService);
    return `http://127.0.0.1:${ctx.get('http').port}`;
  }

  it('serves, updates, uploads, retrieves, and deletes appearance data', async () => {
    const base = await startUiServer();
    const initial = await (await fetch(`${base}/api/appearance`)).json();
    expect(initial.success).toBe(true);
    expect(initial.data.config.version).toBe(4);
    expect(initial.data.config.themes.web.themeId).toBe('tokyo-night');

    const updated = await (await fetch(`${base}/api/appearance`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        themes: { web: { updatedAt: 99, themeId: 'nord' } },
        surfaces: { web: { updatedAt: 99, mode: 'wallpaper', blurRadius: 30 } },
      }),
    })).json();
    expect(updated.data.config.themes.web.themeId).toBe('nord');
    expect(updated.data.config.themes.mobile.themeId).toBe('tokyo-night');
    expect(updated.data.config.surfaces.web.blurRadius).toBe(30);

    const form = new FormData();
    form.append('file', new Blob([VALID_WEBP], { type: 'image/webp' }), 'desk.webp');
    const uploadRes = await fetch(`${base}/api/appearance/wallpapers`, { method: 'POST', body: form });
    expect(uploadRes.status).toBe(201);
    const uploadJson = await uploadRes.json();
    const wp = uploadJson.data.wallpaper;
    expect(wp.mime).toBe('image/webp');

    const imgRes = await fetch(`${base}${wp.url}`);
    expect(imgRes.status).toBe(200);
    expect(imgRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(imgRes.headers.get('content-type')).toContain('image/webp');

    const svgForm = new FormData();
    svgForm.append('file', new Blob(['<svg></svg>'], { type: 'image/svg+xml' }), 'xss.svg');
    const badUpload = await fetch(`${base}/api/appearance/wallpapers`, { method: 'POST', body: svgForm });
    expect(badUpload.status).toBe(400);

    const delRes = await fetch(`${base}/api/appearance/wallpapers/${wp.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    expect((await fetch(`${base}${wp.url}`)).status).toBe(404);
  });
});