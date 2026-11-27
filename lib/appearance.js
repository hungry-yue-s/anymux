import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { replaceFile } from './atomic-file.js';

export const MAX_WALLPAPER_BYTES = 10 * 1024 * 1024;
export const MAX_CUSTOM_WALLPAPERS = 24;
export const MAX_CUSTOM_THEMES = 20;

const WALLPAPER_ID_RE = /^wp-[a-f0-9]{16}\.(png|jpg|webp|avif|gif)$/;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const THEME_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WALLPAPER_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

const THEME_MODES = new Set(['manual', 'system']);
const WALLPAPER_MODES = new Set(['none', 'desktop', 'builtin', 'custom']);
const WALLPAPER_FITS = new Set(['cover', 'contain', 'fill']);
const GLASS_PRESETS = new Set(['solid', 'mist', 'frosted', 'liquid', 'clear-glass', 'custom']);
const NATIVE_ENGINES = new Set(['material', 'liquid-regular', 'liquid-clear', 'system', 'off']);
const CURSOR_STYLES = new Set(['block', 'bar', 'underline']);

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export const DEFAULT_APPEARANCE = Object.freeze({
  version: 2,
  updatedAt: 0,
  themeMode: 'manual',
  themeId: 'tokyo-night',
  lightThemeId: 'oyster',
  darkThemeId: 'tokyo-night',
  accentOverride: null,
  wallpaper: {
    mode: 'none',
    id: null,
    followTheme: true,
    fit: 'cover',
    brightness: 100,
  },
  glass: {
    preset: 'frosted',
    nativeEngine: 'material',
    transparency: 0,
    glassIntensity: 100,
    blurRadius: 22,
    saturation: 135,
    brightness: 100,
    noiseOpacity: 4,
    sidebarTint: 24,
    terminalTint: 66,
    inactivePaneDim: 18,
  },
  typography: {
    fontSize: 14,
    lineHeight: 1.2,
    cursorStyle: 'block',
    cursorBlink: true,
    panePadding: 6,
  },
  customThemes: [],
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function clampFloat(value, min, max, step, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const clamped = Math.max(min, Math.min(max, num));
  return Number((Math.round(clamped / step) * step).toFixed(2));
}

function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return HEX_COLOR_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}

function sanitizeThemeId(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return THEME_ID_RE.test(trimmed) ? trimmed : fallback;
}

export function validateCustomTheme(raw) {
  if (!isPlainObject(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 48) : '';
  if (!name) return null;

  let id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') : '';
  if (!id) {
    id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'theme';
  }
  if (!id.startsWith('custom-')) id = `custom-${id}`;
  id = id.slice(0, 64);
  if (!THEME_ID_RE.test(id)) return null;

  const description = typeof raw.description === 'string' ? raw.description.trim().slice(0, 120) : '自定义导入主题';
  const rawUi = isPlainObject(raw.ui) ? raw.ui : (isPlainObject(raw.colors) ? raw.colors : null);
  const rawTerminal = isPlainObject(raw.terminal) ? raw.terminal : (isPlainObject(raw) && raw.background ? raw : null);
  if (!rawUi && !rawTerminal) return null;

  const cleanUi = {};
  if (rawUi) {
    for (const [k, v] of Object.entries(rawUi)) {
      if (!k.startsWith('--')) continue;
      const hex = normalizeHex(v);
      if (hex) cleanUi[k] = hex;
    }
  }

  const TERMINAL_COLOR_KEYS = [
    'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground',
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
  ];
  const cleanTerminal = {};
  if (rawTerminal) {
    for (const key of TERMINAL_COLOR_KEYS) {
      const hex = normalizeHex(rawTerminal[key]);
      if (hex) cleanTerminal[key] = hex;
    }
  }

  // Must at least provide terminal background + foreground or full UI bg + text.
  const hasTerminalPair = Boolean(cleanTerminal.background && cleanTerminal.foreground);
  const hasUiPair = Boolean(cleanUi['--bg-primary'] && cleanUi['--text-primary']);
  if (!hasTerminalPair && !hasUiPair) return null;

  return {
    id,
    name,
    description,
    ui: cleanUi,
    terminal: cleanTerminal,
  };
}

export function sanitizeAppearanceConfig(raw, existing = DEFAULT_APPEARANCE) {
  const base = isPlainObject(existing) ? existing : DEFAULT_APPEARANCE;
  const input = isPlainObject(raw) ? raw : {};

  const rawWallpaper = isPlainObject(input.wallpaper) ? input.wallpaper : {};
  const baseWallpaper = isPlainObject(base.wallpaper) ? base.wallpaper : DEFAULT_APPEARANCE.wallpaper;
  const wallpaperMode = WALLPAPER_MODES.has(rawWallpaper.mode) ? rawWallpaper.mode : baseWallpaper.mode;
  let wallpaperId = baseWallpaper.id;
  if ('id' in rawWallpaper) {
    if (rawWallpaper.id === null || rawWallpaper.id === '') {
      wallpaperId = null;
    } else if (typeof rawWallpaper.id === 'string' && WALLPAPER_SLUG_RE.test(rawWallpaper.id.trim())) {
      wallpaperId = rawWallpaper.id.trim();
    }
  }
  if (wallpaperMode === 'none' || wallpaperMode === 'desktop') {
    wallpaperId = null;
  }

  const rawGlass = isPlainObject(input.glass) ? input.glass : {};
  const baseGlass = isPlainObject(base.glass) ? base.glass : DEFAULT_APPEARANCE.glass;

  const rawTypo = isPlainObject(input.typography) ? input.typography : {};
  const baseTypo = isPlainObject(base.typography) ? base.typography : DEFAULT_APPEARANCE.typography;

  let customThemes = Array.isArray(base.customThemes) ? base.customThemes : [];
  if (Array.isArray(input.customThemes)) {
    const seen = new Set();
    const list = [];
    for (const item of input.customThemes) {
      const clean = validateCustomTheme(item);
      if (!clean || seen.has(clean.id)) continue;
      seen.add(clean.id);
      list.push(clean);
      if (list.length >= MAX_CUSTOM_THEMES) break;
    }
    customThemes = list;
  }

  const updatedAtRaw = Number(input.updatedAt);
  const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw >= 0 ? Math.round(updatedAtRaw) : Date.now();

  return {
    version: 2,
    updatedAt,
    themeMode: THEME_MODES.has(input.themeMode) ? input.themeMode : base.themeMode,
    themeId: sanitizeThemeId(input.themeId, base.themeId),
    lightThemeId: sanitizeThemeId(input.lightThemeId, base.lightThemeId),
    darkThemeId: sanitizeThemeId(input.darkThemeId, base.darkThemeId),
    accentOverride: 'accentOverride' in input
      ? (input.accentOverride === null || input.accentOverride === '' ? null : normalizeHex(input.accentOverride))
      : (base.accentOverride || null),
    wallpaper: {
      mode: wallpaperMode,
      id: wallpaperId,
      followTheme: typeof rawWallpaper.followTheme === 'boolean' ? rawWallpaper.followTheme : baseWallpaper.followTheme,
      fit: WALLPAPER_FITS.has(rawWallpaper.fit) ? rawWallpaper.fit : baseWallpaper.fit,
      brightness: clampInt(rawWallpaper.brightness, 40, 130, baseWallpaper.brightness),
    },
    glass: {
      preset: GLASS_PRESETS.has(rawGlass.preset) ? rawGlass.preset : baseGlass.preset,
      nativeEngine: NATIVE_ENGINES.has(rawGlass.nativeEngine) ? rawGlass.nativeEngine : baseGlass.nativeEngine,
      transparency: clampInt(rawGlass.transparency, 0, 50, baseGlass.transparency),
      glassIntensity: clampInt(rawGlass.glassIntensity, 0, 100, baseGlass.glassIntensity),
      blurRadius: clampInt(rawGlass.blurRadius, 0, 48, baseGlass.blurRadius),
      saturation: clampInt(rawGlass.saturation, 60, 200, baseGlass.saturation),
      brightness: clampInt(rawGlass.brightness, 75, 125, baseGlass.brightness),
      noiseOpacity: clampInt(rawGlass.noiseOpacity, 0, 18, baseGlass.noiseOpacity),
      sidebarTint: clampInt(rawGlass.sidebarTint, 0, 85, baseGlass.sidebarTint),
      terminalTint: clampInt(rawGlass.terminalTint, 20, 95, baseGlass.terminalTint),
      inactivePaneDim: clampInt(rawGlass.inactivePaneDim, 0, 45, baseGlass.inactivePaneDim),
    },
    typography: {
      fontSize: clampInt(rawTypo.fontSize, 10, 22, baseTypo.fontSize),
      lineHeight: clampFloat(rawTypo.lineHeight, 1.0, 1.8, 0.05, baseTypo.lineHeight),
      cursorStyle: CURSOR_STYLES.has(rawTypo.cursorStyle) ? rawTypo.cursorStyle : baseTypo.cursorStyle,
      cursorBlink: typeof rawTypo.cursorBlink === 'boolean' ? rawTypo.cursorBlink : baseTypo.cursorBlink,
      panePadding: clampInt(rawTypo.panePadding, 0, 16, baseTypo.panePadding),
    },
    customThemes,
  };
}

/**
 * Verifies raster image magic bytes. Rejects SVG, HTML, scripts, and arbitrary blobs
 * so uploaded wallpapers cannot introduce stored XSS.
 */
export function detectImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return { ext: 'png', mime: 'image/png' };
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }

  // WebP: RIFF....WEBP
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }

  // GIF: GIF87a / GIF89a
  const gifSig = buffer.subarray(0, 6).toString('ascii');
  if (gifSig === 'GIF87a' || gifSig === 'GIF89a') {
    return { ext: 'gif', mime: 'image/gif' };
  }

  // AVIF / ISOBMFF: ....ftyp + avif / avis / mif1
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis' || brand === 'mif1') {
      return { ext: 'avif', mime: 'image/avif' };
    }
  }

  return null;
}

function mimeForExt(ext) {
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.avif': return 'image/avif';
    default: return 'application/octet-stream';
  }
}

function sanitizeDisplayName(name) {
  const base = String(name || 'wallpaper')
    .replace(/[/\\]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
  return (base || 'wallpaper').slice(0, 80);
}

export class AppearanceStore {
  constructor(configDir = null) {
    this.configDir = configDir || null;
    this.filePath = configDir ? join(configDir, 'appearance.json') : null;
    this.wallpapersDir = configDir ? join(configDir, 'wallpapers') : null;
    this._config = sanitizeAppearanceConfig(DEFAULT_APPEARANCE, DEFAULT_APPEARANCE);
    this._wallpapersMeta = {};
    this._memoryWallpapers = new Map();
    this._queue = Promise.resolve();
    this._loadPromise = null;
  }

  ready() {
    if (!this._loadPromise) this._loadPromise = this.load();
    return this._loadPromise;
  }

  async load() {
    if (!this.filePath) return this.getConfig();
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this._config = sanitizeAppearanceConfig(parsed, DEFAULT_APPEARANCE);
      if (isPlainObject(parsed?._wallpapers)) {
        const cleanMeta = {};
        for (const [id, meta] of Object.entries(parsed._wallpapers)) {
          if (!WALLPAPER_ID_RE.test(id) || !isPlainObject(meta)) continue;
          cleanMeta[id] = {
            id,
            name: sanitizeDisplayName(meta.name || id),
            mime: typeof meta.mime === 'string' ? meta.mime : mimeForExt(extname(id)),
            size: Number(meta.size) || 0,
            createdAt: Number(meta.createdAt) || 0,
          };
        }
        this._wallpapersMeta = cleanMeta;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this._config = sanitizeAppearanceConfig(DEFAULT_APPEARANCE, DEFAULT_APPEARANCE);
      }
    }
    return this.getConfig();
  }

  getConfig() {
    return structuredClone(this._config);
  }

  async updateConfig(patch) {
    await this.ready();
    return this._enqueue(async () => {
      const next = sanitizeAppearanceConfig(patch, this._config);
      this._config = next;
      await this._writeUnsafe();
      return this.getConfig();
    });
  }

  async listWallpapers() {
    await this.ready();
    if (!this.wallpapersDir) {
      return Array.from(this._memoryWallpapers.values()).map((entry) => ({
        id: entry.id,
        name: entry.name,
        mime: entry.mime,
        size: entry.buffer.length,
        createdAt: entry.createdAt,
        url: `/api/appearance/wallpapers/${entry.id}`,
      }));
    }
    let entries = [];
    try {
      entries = await readdir(this.wallpapersDir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const items = [];
    for (const file of entries) {
      if (!WALLPAPER_ID_RE.test(file)) continue;
      const meta = this._wallpapersMeta[file] || {};
      let size = meta.size || 0;
      let createdAt = meta.createdAt || 0;
      if (!size || !createdAt) {
        try {
          const info = await stat(join(this.wallpapersDir, file));
          size = info.size;
          createdAt = Math.round(info.mtimeMs);
        } catch {
          continue;
        }
      }
      items.push({
        id: file,
        name: meta.name || file,
        mime: meta.mime || mimeForExt(extname(file)),
        size,
        createdAt,
        url: `/api/appearance/wallpapers/${file}`,
      });
    }
    items.sort((a, b) => b.createdAt - a.createdAt);
    return items;
  }

  async saveWallpaper(buffer, originalName = 'wallpaper') {
    await this.ready();
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      const err = new Error('Empty wallpaper file');
      err.status = 400;
      throw err;
    }
    if (buffer.length > MAX_WALLPAPER_BYTES) {
      const err = new Error('Wallpaper exceeds 10MB limit');
      err.status = 413;
      throw err;
    }
    const detected = detectImageFormat(buffer);
    if (!detected) {
      const err = new Error('Unsupported image format (PNG, JPEG, WebP, GIF, AVIF only)');
      err.status = 400;
      throw err;
    }

    return this._enqueue(async () => {
      const existing = await this._listIdsUnsafe();
      if (existing.length >= MAX_CUSTOM_WALLPAPERS) {
        const err = new Error(`Maximum ${MAX_CUSTOM_WALLPAPERS} custom wallpapers reached`);
        err.status = 400;
        throw err;
      }
      const id = `wp-${randomBytes(8).toString('hex')}.${detected.ext}`;
      const record = {
        id,
        name: sanitizeDisplayName(originalName),
        mime: detected.mime,
        size: buffer.length,
        createdAt: Date.now(),
      };
      if (this.wallpapersDir) {
        await mkdir(this.wallpapersDir, { recursive: true, mode: DIR_MODE });
        const dest = join(this.wallpapersDir, id);
        const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(tmp, buffer, { mode: FILE_MODE });
        await replaceFile(tmp, dest);
        this._wallpapersMeta[id] = record;
        await this._writeUnsafe();
      } else {
        this._memoryWallpapers.set(id, { ...record, buffer: Buffer.from(buffer) });
      }
      return { ...record, url: `/api/appearance/wallpapers/${id}` };
    });
  }

  async resolveWallpaperFile(id) {
    await this.ready();
    if (typeof id !== 'string' || !WALLPAPER_ID_RE.test(id)) return null;
    if (!this.wallpapersDir) {
      const mem = this._memoryWallpapers.get(id);
      return mem ? { id, mime: mem.mime, buffer: mem.buffer } : null;
    }
    const filePath = join(this.wallpapersDir, id);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return null;
      return {
        id,
        filePath,
        mime: this._wallpapersMeta[id]?.mime || mimeForExt(extname(id)),
      };
    } catch {
      return null;
    }
  }

  async deleteWallpaper(id) {
    await this.ready();
    if (typeof id !== 'string' || !WALLPAPER_ID_RE.test(id)) return false;
    return this._enqueue(async () => {
      let deleted = false;
      if (this.wallpapersDir) {
        try {
          await unlink(join(this.wallpapersDir, id));
          deleted = true;
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        delete this._wallpapersMeta[id];
      } else {
        deleted = this._memoryWallpapers.delete(id);
      }
      if (this._config.wallpaper.mode === 'custom' && this._config.wallpaper.id === id) {
        this._config = sanitizeAppearanceConfig({
          ...this._config,
          updatedAt: Date.now(),
          wallpaper: { ...this._config.wallpaper, mode: 'none', id: null },
        }, this._config);
      }
      if (this.filePath) await this._writeUnsafe();
      return deleted;
    });
  }

  async _listIdsUnsafe() {
    if (!this.wallpapersDir) return Array.from(this._memoryWallpapers.keys());
    try {
      const entries = await readdir(this.wallpapersDir);
      return entries.filter((name) => WALLPAPER_ID_RE.test(name));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  _enqueue(fn) {
    const next = this._queue.then(fn, fn);
    this._queue = next.catch(() => {});
    return next;
  }

  async _writeUnsafe() {
    if (!this.filePath) return;
    await mkdir(this.configDir, { recursive: true, mode: DIR_MODE });
    const payload = { ...this._config, _wallpapers: this._wallpapersMeta };
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: FILE_MODE });
    await replaceFile(tmp, this.filePath);
  }
}
