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

describe('appearance config & store', () => {
  it('sanitizes and clamps nested config values safely', () => {
    const clean = sanitizeAppearanceConfig({
      themeMode: 'system',
      themeId: 'invalid id!',
      lightThemeId: 'github-light',
      darkThemeId: 'nord',
      accentOverride: ' #7AA2F7 ',
      wallpaper: { mode: 'builtin', id: 'nord-fjord', followTheme: false, fit: 'contain', brightness: 250 },
      glass: {
        preset: 'liquid',
        nativeEngine: 'liquid-clear',
        transparency: 99,
        glassIntensity: -5,
        blurRadius: 100,
        saturation: 300,
        brightness: 20,
        noiseOpacity: 50,
        sidebarTint: 99,
        terminalTint: 5,
        inactivePaneDim: 99,
      },
      typography: { fontSize: 40, lineHeight: 2.5, cursorStyle: 'bar', cursorBlink: false, panePadding: 30 },
    });

    expect(clean.themeMode).toBe('system');
    expect(clean.themeId).toBe(DEFAULT_APPEARANCE.themeId);
    expect(clean.lightThemeId).toBe('github-light');
    expect(clean.darkThemeId).toBe('nord');
    expect(clean.accentOverride).toBe('#7aa2f7');
    expect(clean.wallpaper).toEqual({
      mode: 'builtin',
      id: 'nord-fjord',
      followTheme: false,
      fit: 'contain',
      brightness: 130,
    });
    expect(clean.glass).toEqual({
      preset: 'liquid',
      nativeEngine: 'liquid-clear',
      transparency: 50,
      glassIntensity: 0,
      blurRadius: 48,
      saturation: 200,
      brightness: 75,
      noiseOpacity: 18,
      sidebarTint: 85,
      terminalTint: 20,
      inactivePaneDim: 45,
    });
    expect(clean.typography).toEqual({
      fontSize: 22,
      lineHeight: 1.8,
      cursorStyle: 'bar',
      cursorBlink: false,
      panePadding: 16,
    });
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

  it('persists config, uploads wallpapers, rejects traversal, and cleans up on delete', async () => {
    const dir = makeTempDir();
    const store = new AppearanceStore(dir);
    await store.updateConfig({ themeId: 'prism', updatedAt: 12345 });

    const uploaded = await store.saveWallpaper(VALID_PNG, '../../evil.png');
    expect(uploaded.id).toMatch(/^wp-[a-f0-9]{16}\.png$/);
    expect(uploaded.mime).toBe('image/png');
    await store.updateConfig({ wallpaper: { mode: 'custom', id: uploaded.id, followTheme: false } });

    const reloaded = new AppearanceStore(dir);
    await reloaded.ready();
    expect(reloaded.getConfig().themeId).toBe('prism');
    expect(reloaded.getConfig().wallpaper).toMatchObject({ mode: 'custom', id: uploaded.id });
    expect(await reloaded.listWallpapers()).toHaveLength(1);
    expect(await reloaded.resolveWallpaperFile('../secret.png')).toBeNull();
    expect(await reloaded.resolveWallpaperFile(uploaded.id)).toMatchObject({ id: uploaded.id, mime: 'image/png' });

    expect(await reloaded.deleteWallpaper(uploaded.id)).toBe(true);
    expect(await reloaded.listWallpapers()).toHaveLength(0);
    expect(reloaded.getConfig().wallpaper).toMatchObject({ mode: 'none', id: null });
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
    expect(initial.data.config.themeId).toBe('tokyo-night');

    const updated = await (await fetch(`${base}/api/appearance`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ themeId: 'nord', glass: { blurRadius: 30 } }),
    })).json();
    expect(updated.data.config.themeId).toBe('nord');
    expect(updated.data.config.glass.blurRadius).toBe(30);

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
