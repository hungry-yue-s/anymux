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
const WALLPAPER_SOURCES = new Set(['follow', 'builtin', 'custom']);
const WALLPAPER_FITS = new Set(['cover', 'contain', 'fill']);
const WEB_PRESETS = new Set(['clear', 'mist', 'frosted', 'custom']);
const NATIVE_ENGINES = new Set(['material', 'liquid-regular', 'liquid-clear', 'system']);
const CURSOR_STYLES = new Set(['block', 'bar', 'underline']);
const SURFACE_PROFILES = ['native', 'web', 'mobile'];

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export function createDefaultSurface(profile = 'web') {
  const isMobile = profile === 'mobile';
  return Object.freeze({
    updatedAt: 0,
    mode: 'solid',
    wallpaperSource: 'follow',
    wallpaperId: null,
    wallpaperFit: 'cover',
    wallpaperBrightness: 100,
    webPreset: isMobile ? 'mist' : 'frosted',
    blurRadius: isMobile ? 14 : 22,
    saturation: isMobile ? 118 : 135,
    brightness: 100,
    noiseOpacity: isMobile ? 0 : 4,
    sidebarTint: isMobile ? 38 : 24,
    terminalTint: isMobile ? 78 : 66,
    nativeEngine: 'material',
    transparency: 0,
    glassIntensity: 100,
  });
}

export const DEFAULT_APPEARANCE = Object.freeze({
  version: 3,
  updatedAt: 0,
  themeUpdatedAt: 0,
  terminalUpdatedAt: 0,
  theme: Object.freeze({
    mode: 'manual',
    themeId: 'tokyo-night',
    lightThemeId: 'oyster',
    darkThemeId: 'tokyo-night',
    accentOverride: null,
    customThemes: [],
  }),
  terminal: Object.freeze({
    fontSize: 14,
    lineHeight: 1.2,
    cursorStyle: 'block',
    cursorBlink: true,
    panePadding: 6,
    inactivePaneDim: 18,
  }),
  surfaces: Object.freeze({
    native: createDefaultSurface('native'),
    web: createDefaultSurface('web'),
    mobile: createDefaultSurface('mobile'),
  }),
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

function parseTimestamp(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.round(num) : fallback;
}

function allowedSurfaceModes(profile) {
  return profile === 'native' ? new Set(['solid', 'wallpaper', 'desktop']) : new Set(['solid', 'wallpaper']);
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

function isLegacyFlatConfig(raw) {
  if (!isPlainObject(raw) || isPlainObject(raw.surfaces)) return false;
  return 'themeId' in raw
    || 'themeMode' in raw
    || 'wallpaper' in raw
    || 'glass' in raw
    || 'typography' in raw
    || 'customThemes' in raw;
}

function mapLegacyPreset(preset) {
  if (preset === 'solid') return 'clear';
  if (preset === 'mist') return 'mist';
  if (preset === 'frosted' || preset === 'liquid' || preset === 'clear-glass') return 'frosted';
  return 'custom';
}

function migrateLegacyFlatToV3(raw) {
  const wp = isPlainObject(raw.wallpaper) ? raw.wallpaper : {};
  const glass = isPlainObject(raw.glass) ? raw.glass : {};
  const typo = isPlainObject(raw.typography) ? raw.typography : {};
  const ts = parseTimestamp(raw.updatedAt, 0);

  let nativeMode = 'solid';
  let webMode = 'solid';
  let wpSource = wp.followTheme === false ? 'builtin' : 'follow';
  let wpId = typeof wp.id === 'string' && WALLPAPER_SLUG_RE.test(wp.id.trim()) ? wp.id.trim() : null;

  if (wp.mode === 'desktop') {
    nativeMode = 'desktop';
    webMode = 'solid';
    wpId = null;
  } else if (wp.mode === 'builtin') {
    nativeMode = 'wallpaper';
    webMode = 'wallpaper';
    wpSource = wp.followTheme === false && wpId ? 'builtin' : 'follow';
  } else if (wp.mode === 'custom' && wpId) {
    nativeMode = 'wallpaper';
    webMode = 'wallpaper';
    wpSource = 'custom';
  } else {
    wpId = null;
  }

  const sharedSurface = {
    updatedAt: ts,
    wallpaperSource: wpSource,
    wallpaperId: wpSource === 'follow' ? null : wpId,
    wallpaperFit: WALLPAPER_FITS.has(wp.fit) ? wp.fit : 'cover',
    wallpaperBrightness: clampInt(wp.brightness, 40, 130, 100),
    webPreset: mapLegacyPreset(glass.preset),
    blurRadius: clampInt(glass.blurRadius, 0, 48, 22),
    saturation: clampInt(glass.saturation, 60, 200, 135),
    brightness: clampInt(glass.brightness, 75, 125, 100),
    noiseOpacity: clampInt(glass.noiseOpacity, 0, 18, 4),
    sidebarTint: clampInt(glass.sidebarTint, 0, 85, 24),
    terminalTint: clampInt(glass.terminalTint, 20, 95, 66),
    nativeEngine: NATIVE_ENGINES.has(glass.nativeEngine) ? glass.nativeEngine : 'material',
    transparency: clampInt(glass.transparency, 0, 50, 0),
    glassIntensity: clampInt(glass.glassIntensity, 0, 100, 100),
  };

  if (sharedSurface.transparency > 0 && nativeMode === 'solid' && wp.mode !== 'builtin' && wp.mode !== 'custom') {
    nativeMode = 'desktop';
  }

  return {
    version: 3,
    updatedAt: ts,
    themeUpdatedAt: ts,
    terminalUpdatedAt: ts,
    theme: {
      mode: raw.themeMode,
      themeId: raw.themeId,
      lightThemeId: raw.lightThemeId,
      darkThemeId: raw.darkThemeId,
      accentOverride: raw.accentOverride,
      customThemes: raw.customThemes,
    },
    terminal: {
      fontSize: typo.fontSize,
      lineHeight: typo.lineHeight,
      cursorStyle: typo.cursorStyle,
      cursorBlink: typo.cursorBlink,
      panePadding: typo.panePadding,
      inactivePaneDim: glass.inactivePaneDim,
    },
    surfaces: {
      native: { ...sharedSurface, mode: nativeMode },
      web: { ...sharedSurface, mode: webMode, transparency: 0 },
      mobile: {
        ...createDefaultSurface('mobile'),
        updatedAt: ts,
        mode: 'solid',
      },
    },
  };
}

function sanitizeSurface(profile, rawSurface, baseSurface) {
  const base = isPlainObject(baseSurface) ? baseSurface : createDefaultSurface(profile);
  const input = isPlainObject(rawSurface) ? rawSurface : {};
  const allowedModes = allowedSurfaceModes(profile);

  const modeCandidate = input.mode;
  let mode = allowedModes.has(modeCandidate) ? modeCandidate : (allowedModes.has(base.mode) ? base.mode : 'solid');
  const wallpaperSource = WALLPAPER_SOURCES.has(input.wallpaperSource)
    ? input.wallpaperSource
    : (WALLPAPER_SOURCES.has(base.wallpaperSource) ? base.wallpaperSource : 'follow');

  let wallpaperId = base.wallpaperId;
  if ('wallpaperId' in input) {
    if (input.wallpaperId === null || input.wallpaperId === '') {
      wallpaperId = null;
    } else if (typeof input.wallpaperId === 'string' && WALLPAPER_SLUG_RE.test(input.wallpaperId.trim())) {
      wallpaperId = input.wallpaperId.trim();
    }
  }
  if (mode !== 'wallpaper' || wallpaperSource === 'follow') {
    wallpaperId = null;
  }

  const nativeEngine = NATIVE_ENGINES.has(input.nativeEngine)
    ? input.nativeEngine
    : (input.nativeEngine === 'off' ? 'material' : (NATIVE_ENGINES.has(base.nativeEngine) ? base.nativeEngine : 'material'));

  return {
    updatedAt: parseTimestamp(input.updatedAt, base.updatedAt || 0),
    mode,
    wallpaperSource,
    wallpaperId,
    wallpaperFit: WALLPAPER_FITS.has(input.wallpaperFit) ? input.wallpaperFit : base.wallpaperFit,
    wallpaperBrightness: clampInt(input.wallpaperBrightness, 40, 130, base.wallpaperBrightness),
    webPreset: WEB_PRESETS.has(input.webPreset) ? input.webPreset : base.webPreset,
    blurRadius: clampInt(input.blurRadius, 0, 48, base.blurRadius),
    saturation: clampInt(input.saturation, 60, 200, base.saturation),
    brightness: clampInt(input.brightness, 75, 125, base.brightness),
    noiseOpacity: clampInt(input.noiseOpacity, 0, 18, base.noiseOpacity),
    sidebarTint: clampInt(input.sidebarTint, 0, 85, base.sidebarTint),
    terminalTint: clampInt(input.terminalTint, 20, 95, base.terminalTint),
    nativeEngine,
    transparency: profile === 'native' ? clampInt(input.transparency, 0, 50, base.transparency) : 0,
    glassIntensity: clampInt(input.glassIntensity, 0, 100, base.glassIntensity),
  };
}

function shouldAcceptDomain(incomingTs, existingTs) {
  if (incomingTs === null) return true;
  if (!Number.isFinite(existingTs) || existingTs <= 0) return true;
  return incomingTs >= existingTs;
}

export function sanitizeAppearanceConfig(raw, existing = DEFAULT_APPEARANCE) {
  const normalizedBase = isLegacyFlatConfig(existing)
    ? sanitizeAppearanceConfig(migrateLegacyFlatToV3(existing), DEFAULT_APPEARANCE)
    : (isPlainObject(existing) && isPlainObject(existing.surfaces) ? existing : DEFAULT_APPEARANCE);

  const normalizedInput = isLegacyFlatConfig(raw)
    ? migrateLegacyFlatToV3(raw)
    : (isPlainObject(raw) ? raw : {});

  const baseTheme = isPlainObject(normalizedBase.theme) ? normalizedBase.theme : DEFAULT_APPEARANCE.theme;
  const baseTerminal = isPlainObject(normalizedBase.terminal) ? normalizedBase.terminal : DEFAULT_APPEARANCE.terminal;
  const baseSurfaces = isPlainObject(normalizedBase.surfaces) ? normalizedBase.surfaces : DEFAULT_APPEARANCE.surfaces;

  const baseThemeTs = parseTimestamp(normalizedBase.themeUpdatedAt, 0);
  const inThemeTs = parseTimestamp(normalizedInput.themeUpdatedAt, null);
  const acceptTheme = isPlainObject(normalizedInput.theme) && shouldAcceptDomain(inThemeTs, baseThemeTs);
  const rawTheme = acceptTheme ? normalizedInput.theme : {};

  let customThemes = Array.isArray(baseTheme.customThemes) ? baseTheme.customThemes : [];
  if (acceptTheme && Array.isArray(rawTheme.customThemes)) {
    const seen = new Set();
    const list = [];
    for (const item of rawTheme.customThemes) {
      const clean = validateCustomTheme(item);
      if (!clean || seen.has(clean.id)) continue;
      seen.add(clean.id);
      list.push(clean);
      if (list.length >= MAX_CUSTOM_THEMES) break;
    }
    customThemes = list;
  }

  const theme = {
    mode: acceptTheme && THEME_MODES.has(rawTheme.mode) ? rawTheme.mode : baseTheme.mode,
    themeId: acceptTheme ? sanitizeThemeId(rawTheme.themeId, baseTheme.themeId) : baseTheme.themeId,
    lightThemeId: acceptTheme ? sanitizeThemeId(rawTheme.lightThemeId, baseTheme.lightThemeId) : baseTheme.lightThemeId,
    darkThemeId: acceptTheme ? sanitizeThemeId(rawTheme.darkThemeId, baseTheme.darkThemeId) : baseTheme.darkThemeId,
    accentOverride: acceptTheme && 'accentOverride' in rawTheme
      ? (rawTheme.accentOverride === null || rawTheme.accentOverride === '' ? null : normalizeHex(rawTheme.accentOverride))
      : (baseTheme.accentOverride || null),
    customThemes,
  };
  const themeUpdatedAt = acceptTheme
    ? (inThemeTs !== null ? inThemeTs : baseThemeTs)
    : baseThemeTs;

  const baseTermTs = parseTimestamp(normalizedBase.terminalUpdatedAt, 0);
  const inTermTs = parseTimestamp(normalizedInput.terminalUpdatedAt, null);
  const acceptTerm = isPlainObject(normalizedInput.terminal) && shouldAcceptDomain(inTermTs, baseTermTs);
  const rawTerm = acceptTerm ? normalizedInput.terminal : {};

  const terminal = {
    fontSize: clampInt(rawTerm.fontSize, 10, 22, baseTerminal.fontSize),
    lineHeight: clampFloat(rawTerm.lineHeight, 1.0, 1.8, 0.05, baseTerminal.lineHeight),
    cursorStyle: CURSOR_STYLES.has(rawTerm.cursorStyle) ? rawTerm.cursorStyle : baseTerminal.cursorStyle,
    cursorBlink: typeof rawTerm.cursorBlink === 'boolean' ? rawTerm.cursorBlink : baseTerminal.cursorBlink,
    panePadding: clampInt(rawTerm.panePadding, 0, 16, baseTerminal.panePadding),
    inactivePaneDim: clampInt(rawTerm.inactivePaneDim, 0, 45, baseTerminal.inactivePaneDim),
  };
  const terminalUpdatedAt = acceptTerm
    ? (inTermTs !== null ? inTermTs : baseTermTs)
    : baseTermTs;

  const rawSurfaces = isPlainObject(normalizedInput.surfaces) ? normalizedInput.surfaces : {};
  const surfaces = {};
  let maxSurfaceTs = 0;
  for (const profile of SURFACE_PROFILES) {
    const baseSurface = isPlainObject(baseSurfaces[profile]) ? baseSurfaces[profile] : createDefaultSurface(profile);
    const inSurface = rawSurfaces[profile];
    const baseSurfaceTs = parseTimestamp(baseSurface.updatedAt, 0);
    const inSurfaceTs = isPlainObject(inSurface) ? parseTimestamp(inSurface.updatedAt, null) : null;
    if (isPlainObject(inSurface) && shouldAcceptDomain(inSurfaceTs, baseSurfaceTs)) {
      surfaces[profile] = sanitizeSurface(profile, inSurface, baseSurface);
    } else {
      surfaces[profile] = sanitizeSurface(profile, {}, baseSurface);
    }
    if (surfaces[profile].updatedAt > maxSurfaceTs) {
      maxSurfaceTs = surfaces[profile].updatedAt;
    }
  }

  const inputTopTs = parseTimestamp(normalizedInput.updatedAt, 0);
  const baseTopTs = parseTimestamp(normalizedBase.updatedAt, 0);
  const updatedAt = Math.max(baseTopTs, inputTopTs, themeUpdatedAt, terminalUpdatedAt, maxSurfaceTs);

  return {
    version: 3,
    updatedAt,
    themeUpdatedAt,
    terminalUpdatedAt,
    theme,
    terminal,
    surfaces,
  };
}

/**
 * Verifies raster image magic bytes. Rejects SVG, HTML, scripts, and arbitrary blobs
 * so uploaded wallpapers cannot introduce stored XSS.
 */
export function detectImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return { ext: 'png', mime: 'image/png' };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }

  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }

  const gifSig = buffer.subarray(0, 6).toString('ascii');
  if (gifSig === 'GIF87a' || gifSig === 'GIF89a') {
    return { ext: 'gif', mime: 'image/gif' };
  }

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
      const now = Date.now();
      const updatedSurfaces = {};
      let mutated = false;
      for (const profile of SURFACE_PROFILES) {
        const current = this._config.surfaces[profile];
        if (current.mode === 'wallpaper' && current.wallpaperSource === 'custom' && current.wallpaperId === id) {
          updatedSurfaces[profile] = {
            ...current,
            updatedAt: now,
            mode: 'solid',
            wallpaperSource: 'follow',
            wallpaperId: null,
          };
          mutated = true;
        }
      }
      if (mutated) {
        this._config = sanitizeAppearanceConfig({
          ...this._config,
          updatedAt: now,
          surfaces: updatedSurfaces,
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