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

describe('appearance config & store v3', () => {
  it('sanitizes v3 domain config, enforces device surface modes, and clamps values safely', () => {
    const clean = sanitizeAppearanceConfig({
      themeUpdatedAt: 1000,
      terminalUpdatedAt: 2000,
      theme: {
        mode: 'system',
        themeId: 'invalid id!',
        lightThemeId: 'github-light',
        darkThemeId: 'nord',
        accentOverride: ' #7AA2F7 ',
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

    expect(clean.version).toBe(3);
    expect(clean.updatedAt).toBe(3000);
    expect(clean.theme).toMatchObject({
      mode: 'system',
      themeId: DEFAULT_APPEARANCE.theme.themeId,
      lightThemeId: 'github-light',
      darkThemeId: 'nord',
      accentOverride: '#7aa2f7',
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

  it('migrates legacy v2 flat config without leaking desktop mode to web/mobile', () => {
    const migrated = sanitizeAppearanceConfig({
      version: 2,
      updatedAt: 5555,
      themeMode: 'system',
      themeId: 'nord',
      wallpaper: { mode: 'desktop', id: null, followTheme: true, fit: 'cover', brightness: 100 },
      glass: { preset: 'liquid', nativeEngine: 'liquid-regular', transparency: 32, blurRadius: 34, inactivePaneDim: 24 },
      typography: { fontSize: 16, lineHeight: 1.4, cursorStyle: 'underline', cursorBlink: false, panePadding: 8 },
    });

    expect(migrated.version).toBe(3);
    expect(migrated.theme.mode).toBe('system');
    expect(migrated.theme.themeId).toBe('nord');
    expect(migrated.terminal).toEqual({
      fontSize: 16,
      lineHeight: 1.4,
      cursorStyle: 'underline',
      cursorBlink: false,
      panePadding: 8,
      inactivePaneDim: 24,
    });
    expect(migrated.surfaces.native.mode).toBe('desktop');
    expect(migrated.surfaces.native.transparency).toBe(32);
    expect(migrated.surfaces.web.mode).toBe('solid');
    expect(migrated.surfaces.web.transparency).toBe(0);
    expect(migrated.surfaces.mobile.mode).toBe('solid');
  });

  it('merges per-domain timestamps so stale device slots do not clobber newer ones', () => {
    const existing = sanitizeAppearanceConfig({
      themeUpdatedAt: 200,
      theme: { themeId: 'prism' },
      surfaces: {
        native: { updatedAt: 500, mode: 'desktop', transparency: 30 },
        web: { updatedAt: 100, mode: 'solid' },
      },
    });
    const merged = sanitizeAppearanceConfig({
      themeUpdatedAt: 150, // stale -> keep prism
      theme: { themeId: 'nord' },
      surfaces: {
        native: { updatedAt: 200, mode: 'solid', transparency: 0 }, // stale -> keep desktop
        web: { updatedAt: 400, mode: 'wallpaper', wallpaperSource: 'builtin', wallpaperId: 'nord-fjord' }, // newer -> accept
      },
    }, existing);

    expect(merged.theme.themeId).toBe('prism');
    expect(merged.surfaces.native.mode).toBe('desktop');
    expect(merged.surfaces.native.transparency).toBe(30);
    expect(merged.surfaces.web.mode).toBe('wallpaper');
    expect(merged.surfaces.web.wallpaperId).toBe('nord-fjord');
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
    await store.updateConfig({ themeUpdatedAt: 12345, theme: { themeId: 'prism' } });

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
    expect(reloaded.getConfig().theme.themeId).toBe('prism');
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
    expect(initial.data.config.version).toBe(3);
    expect(initial.data.config.theme.themeId).toBe('tokyo-night');

    const updated = await (await fetch(`${base}/api/appearance`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        themeUpdatedAt: 99,
        theme: { themeId: 'nord' },
        surfaces: { web: { updatedAt: 99, mode: 'wallpaper', blurRadius: 30 } },
      }),
    })).json();
    expect(updated.data.config.theme.themeId).toBe('nord');
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