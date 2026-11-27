import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { replaceFile } from '../atomic-file.js';

export const DOCK_STATE_VERSION = 1;
export const MAX_FILES_PER_WINDOW = 12;
export const MAX_BLOCKS_PER_WINDOW = 12;
export const MAX_SERVER_BLOCKS = 12;
export const MAX_ORDER = 40;
export const MAX_NOTICES = 50;
export const MAX_ARCHIVED_INSTANCES = 1;
export const ARCHIVE_TTL_MS = 24 * 60 * 60 * 1000;

const WINDOW_ID_RE = /^@\d+$/;
const PANE_ID_RE = /^%\d+$/;
const KIND_RE = /^[a-z0-9_-]{1,32}$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const VALID_MODES = new Set(['dock', 'float', 'max']);
const MAX_PARAMS_BYTES = 8192;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function validationError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && value.charAt(0) === '/' && !CONTROL_RE.test(value);
}

function isValidKeyString(value, maxLen = 4160) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen && !CONTROL_RE.test(value);
}

function normalizeFragment(value) {
  if (typeof value !== 'string' || !value || value.length > 200 || CONTROL_RE.test(value)) return null;
  return value;
}

function normalizePaneId(value) {
  return typeof value === 'string' && PANE_ID_RE.test(value) ? value : null;
}

function normalizeMode(value) {
  return VALID_MODES.has(value) ? value : 'dock';
}

function normalizeParams(value) {
  if (value == null) return {};
  if (!isPlainObject(value)) throw validationError('invalid_params');
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_PARAMS_BYTES) throw validationError('params_too_large');
  return JSON.parse(serialized);
}

function normalizeText(value, maxLen = 256) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function normalizeWindowIndex(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isInteger(num) && num >= 0 ? num : String(value).slice(0, 32);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function emptyState() {
  return {
    version: DOCK_STATE_VERSION,
    instanceId: null,
    revision: 0,
    windows: {},
    serverBlocks: { revision: 0, activeKey: null, items: [] },
    notices: [],
    archivedInstances: [],
  };
}

function emptyWindow(meta = {}) {
  return {
    revision: 0,
    updatedAt: Date.now(),
    sessionName: normalizeText(meta.sessionName),
    windowIndex: normalizeWindowIndex(meta.windowIndex),
    windowName: normalizeText(meta.windowName),
    activeKey: null,
    order: [],
    items: [],
  };
}

function ensureKeyInOrder(order, key) {
  if (!isValidKeyString(key)) return;
  if (!order.includes(key)) {
    order.push(key);
    if (order.length > MAX_ORDER) order.splice(0, order.length - MAX_ORDER);
  }
}

function removeKeyFromOrder(order, key) {
  const idx = order.indexOf(key);
  if (idx >= 0) order.splice(idx, 1);
}

function reorderItems(items, order) {
  if (!Array.isArray(order) || order.length === 0 || items.length < 2) return items;
  const rank = new Map();
  order.forEach((key, idx) => rank.set(key, idx));
  return items
    .map((item, idx) => ({ item, at: rank.has(item.key) ? rank.get(item.key) : order.length + idx }))
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.item);
}

function trimWindowItems(win) {
  const files = win.items.filter((item) => item.type === 'file');
  if (files.length > MAX_FILES_PER_WINDOW) {
    const drop = new Set(files.slice(0, files.length - MAX_FILES_PER_WINDOW).map((item) => item.key));
    win.items = win.items.filter((item) => !drop.has(item.key));
    win.order = win.order.filter((key) => !drop.has(key));
  }
  const blocks = win.items.filter((item) => item.type === 'block');
  if (blocks.length > MAX_BLOCKS_PER_WINDOW) {
    const drop = new Set(blocks.slice(0, blocks.length - MAX_BLOCKS_PER_WINDOW).map((item) => item.key));
    win.items = win.items.filter((item) => !drop.has(item.key));
    win.order = win.order.filter((key) => !drop.has(key));
  }
}

function fallbackActiveKey(win, removedKey) {
  if (win.activeKey !== removedKey) return win.activeKey;
  return win.items.length ? win.items[win.items.length - 1].key : null;
}

function noticeMergeKey(notice) {
  const target = notice && notice.target;
  if (target && target.instanceId && target.windowId) {
    return JSON.stringify([target.instanceId, target.windowId, notice.type, notice.path]);
  }
  return 'id:' + String(notice?.id || '');
}

function normalizeNotice(raw, now = Date.now()) {
  if (!isPlainObject(raw)) throw validationError('invalid_notice');
  const type = raw.type === 'git' ? 'git' : raw.type === 'document' ? 'document' : null;
  if (!type) throw validationError('invalid_notice_type');
  if (!isValidPath(raw.path)) throw validationError('invalid_notice_path');
  const id = isValidKeyString(raw.id, 512)
    ? raw.id
    : `${type === 'git' ? 'git' : 'doc'}-${encodeURIComponent([raw.target?.instanceId || '', raw.target?.windowId || '', raw.path, raw.commit || ''].join('\u0000'))}`;
  let target = null;
  if (isPlainObject(raw.target) && typeof raw.target.instanceId === 'string' && raw.target.instanceId
    && WINDOW_ID_RE.test(String(raw.target.windowId || ''))) {
    target = {
      instanceId: normalizeText(raw.target.instanceId, 128),
      windowId: raw.target.windowId,
      sessionId: typeof raw.target.sessionId === 'string' ? normalizeText(raw.target.sessionId, 64) : '',
      paneId: normalizePaneId(raw.target.paneId),
    };
  }
  const read = raw.read === true;
  return {
    id,
    type,
    path: raw.path,
    paneId: normalizePaneId(raw.paneId),
    commit: typeof raw.commit === 'string' ? normalizeText(raw.commit, 64) : null,
    dirtyCount: Number.isInteger(raw.dirtyCount) && raw.dirtyCount >= 0 ? raw.dirtyCount : null,
    fragment: normalizeFragment(raw.fragment),
    message: normalizeText(raw.message, 512),
    timestamp: Number.isFinite(Number(raw.timestamp)) && Number(raw.timestamp) > 0 ? Number(raw.timestamp) : now,
    read,
    readAt: read ? (Number.isFinite(Number(raw.readAt)) ? Number(raw.readAt) : now) : null,
    reminderSeen: raw.reminderSeen === true,
    session: normalizeText(raw.session, 128),
    windowIndex: normalizeWindowIndex(raw.windowIndex),
    windowName: normalizeText(raw.windowName, 128),
    target,
  };
}

function sanitizeLoadedWindow(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.items)) return null;
  const win = emptyWindow(raw);
  win.revision = Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  win.updatedAt = Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : Date.now();
  const seen = new Set();
  for (const item of raw.items) {
    if (!isPlainObject(item)) continue;
    if (item.type === 'file' && isValidPath(item.path)) {
      const key = 'file:' + item.path;
      if (seen.has(key)) continue;
      seen.add(key);
      win.items.push({
        type: 'file',
        key,
        path: item.path,
        paneId: normalizePaneId(item.paneId),
        fragment: normalizeFragment(item.fragment),
        unread: item.unread === true,
        automatic: item.automatic === true,
        updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : win.updatedAt,
      });
    } else if (item.type === 'block' && KIND_RE.test(String(item.kind || '')) && isValidKeyString(item.persistKey)) {
      const key = 'block:' + item.persistKey;
      if (seen.has(key)) continue;
      seen.add(key);
      let params = {};
      try { params = normalizeParams(item.params); } catch { params = {}; }
      win.items.push({
        type: 'block',
        key,
        kind: item.kind,
        persistKey: item.persistKey,
        params,
        mode: normalizeMode(item.mode),
        unread: item.unread === true,
        arrivalId: typeof item.arrivalId === 'string' ? normalizeText(item.arrivalId, 64) : null,
        updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : win.updatedAt,
      });
    }
  }
  trimWindowItems(win);
  if (win.items.length === 0) return null;
  if (Array.isArray(raw.order)) {
    win.order = raw.order.filter((k) => isValidKeyString(k)).slice(0, MAX_ORDER);
  }
  win.activeKey = isValidKeyString(raw.activeKey) ? raw.activeKey : null;
  return win;
}

function sanitizeServerBlocks(raw) {
  const out = { revision: 0, activeKey: null, items: [] };
  if (!isPlainObject(raw) || !Array.isArray(raw.items)) return out;
  out.revision = Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  const seen = new Set();
  for (const item of raw.items) {
    if (!isPlainObject(item) || !KIND_RE.test(String(item.kind || '')) || !isValidKeyString(item.persistKey)) continue;
    const key = 'block:' + item.persistKey;
    if (seen.has(key)) continue;
    seen.add(key);
    let params = {};
    try { params = normalizeParams(item.params); } catch { params = {}; }
    out.items.push({
      type: 'block',
      key,
      kind: item.kind,
      persistKey: item.persistKey,
      params,
      mode: normalizeMode(item.mode),
      unread: item.unread === true,
      arrivalId: typeof item.arrivalId === 'string' ? normalizeText(item.arrivalId, 64) : null,
      updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : Date.now(),
    });
  }
  out.items = out.items.slice(0, MAX_SERVER_BLOCKS);
  if (isValidKeyString(raw.activeKey) && out.items.some((item) => item.key === raw.activeKey)) {
    out.activeKey = raw.activeKey;
  }
  return out;
}

/**
 * Server-side persistence for right-docked files, tool blocks, and preview notices.
 *
 * Uses a serialized promise queue and atomic file replacement (`replaceFile`).
 */
export class DockStore {
  constructor(filePath, { now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this._now = now;
    this._state = emptyState();
    this._queue = Promise.resolve();
    this._loaded = false;
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (isPlainObject(parsed) && parsed.version === DOCK_STATE_VERSION) {
        const next = emptyState();
        next.instanceId = typeof parsed.instanceId === 'string' && parsed.instanceId ? parsed.instanceId : null;
        next.revision = Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0;
        if (isPlainObject(parsed.windows)) {
          for (const [winId, winRaw] of Object.entries(parsed.windows)) {
            if (!WINDOW_ID_RE.test(winId)) continue;
            const win = sanitizeLoadedWindow(winRaw);
            if (win) next.windows[winId] = win;
          }
        }
        next.serverBlocks = sanitizeServerBlocks(parsed.serverBlocks);
        if (Array.isArray(parsed.notices)) {
          const seen = new Set();
          for (const entry of parsed.notices) {
            try {
              const notice = normalizeNotice(entry, this._now());
              const mergeKey = noticeMergeKey(notice);
              if (seen.has(mergeKey)) continue;
              seen.add(mergeKey);
              next.notices.push(notice);
            } catch { /* drop malformed */ }
          }
          next.notices = next.notices.slice(0, MAX_NOTICES);
        }
        if (Array.isArray(parsed.archivedInstances)) {
          const cutoff = this._now() - ARCHIVE_TTL_MS;
          next.archivedInstances = parsed.archivedInstances
            .filter((entry) => isPlainObject(entry) && typeof entry.instanceId === 'string' && entry.instanceId
              && Number(entry.archivedAt) > cutoff)
            .slice(-MAX_ARCHIVED_INSTANCES);
        }
        this._state = next;
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        // Corrupt JSON starts fresh rather than crashing startup.
        this._state = emptyState();
      }
    }
    this._loaded = true;
    return this.getSnapshot();
  }

  getSnapshot({ windowId = null } = {}) {
    const windows = {};
    if (windowId && WINDOW_ID_RE.test(String(windowId))) {
      if (this._state.windows[windowId]) {
        windows[windowId] = clone(this._state.windows[windowId]);
      }
    } else {
      for (const [id, win] of Object.entries(this._state.windows)) {
        windows[id] = clone(win);
      }
    }
    return {
      version: DOCK_STATE_VERSION,
      instanceId: this._state.instanceId,
      revision: this._state.revision,
      windows,
      serverBlocks: clone(this._state.serverBlocks),
      notices: clone(this._state.notices),
    };
  }

  setServerInstance(nextInstanceId) {
    const next = typeof nextInstanceId === 'string' ? nextInstanceId.trim() : '';
    if (!next) return Promise.resolve({ changed: false, instanceId: this._state.instanceId });
    return this._enqueue(async () => {
      const result = this._setServerInstanceUnsafe(next);
      if (result.changed) await this._writeUnsafe();
      return result;
    });
  }

  _setServerInstanceUnsafe(nextInstanceId) {
    const prev = this._state.instanceId;
    if (prev === nextInstanceId) {
      return { changed: false, instanceId: prev };
    }
    const now = this._now();
    const cutoff = now - ARCHIVE_TTL_MS;
    this._state.archivedInstances = this._state.archivedInstances
      .filter((entry) => Number(entry.archivedAt) > cutoff);

    if (prev && (Object.keys(this._state.windows).length > 0 || this._state.notices.length > 0)) {
      this._state.archivedInstances = [
        {
          instanceId: prev,
          archivedAt: now,
          windows: clone(this._state.windows),
          notices: clone(this._state.notices),
        },
      ].slice(-MAX_ARCHIVED_INSTANCES);
    }

    this._state.instanceId = nextInstanceId;
    this._state.windows = {};
    // Keep notices belonging to nextInstanceId if any, drop old instance notices.
    this._state.notices = this._state.notices.filter((n) => !n.target || n.target.instanceId === nextInstanceId);
    this._state.revision += 1;
    return { changed: true, prevInstance: prev, nextInstance: nextInstanceId, revision: this._state.revision };
  }

  applyWindowOp(windowId, op, meta = {}) {
    if (!WINDOW_ID_RE.test(String(windowId || ''))) {
      return Promise.reject(validationError('invalid_window_id'));
    }
    if (!isPlainObject(op) || typeof op.type !== 'string') {
      return Promise.reject(validationError('invalid_op'));
    }
    return this._enqueue(async () => {
      const result = this._applyWindowOpUnsafe(windowId, op, meta);
      if (result.changed) await this._writeUnsafe();
      return result;
    });
  }

  _applyWindowOpUnsafe(windowId, op, meta = {}) {
    if (meta.instanceId && this._state.instanceId && meta.instanceId !== this._state.instanceId) {
      return {
        changed: false,
        stale: true,
        instanceId: this._state.instanceId,
        revision: this._state.revision,
        windowId,
        window: clone(this._state.windows[windowId] || null),
      };
    }
    if (!this._state.instanceId && typeof meta.instanceId === 'string' && meta.instanceId) {
      this._state.instanceId = meta.instanceId;
    }

    const now = this._now();
    let win = this._state.windows[windowId];
    const ensureWin = () => {
      if (!win) {
        win = emptyWindow(meta);
        this._state.windows[windowId] = win;
      } else {
        if (typeof meta.sessionName === 'string' && meta.sessionName) win.sessionName = normalizeText(meta.sessionName);
        if (meta.windowIndex !== undefined && meta.windowIndex !== null) win.windowIndex = normalizeWindowIndex(meta.windowIndex);
        if (typeof meta.windowName === 'string' && meta.windowName) win.windowName = normalizeText(meta.windowName);
      }
      return win;
    };

    let changed = false;

    if (op.type === 'upsert-file') {
      if (!isValidPath(op.path)) throw validationError('invalid_path');
      const replaces = op.replaces != null ? op.replaces : null;
      if (replaces !== null && !isValidPath(replaces)) throw validationError('invalid_replaces');
      const fragment = op.fragment != null ? normalizeFragment(op.fragment) : null;
      const paneId = normalizePaneId(op.paneId);
      const targetWin = ensureWin();
      const key = 'file:' + op.path;
      const replaceKey = replaces ? 'file:' + replaces : null;
      let existing = targetWin.items.find((item) => item.key === key);
      const replaced = replaceKey && replaceKey !== key
        ? targetWin.items.find((item) => item.key === replaceKey)
        : null;

      if (existing) {
        if (paneId && existing.paneId !== paneId) {
          existing.paneId = paneId;
          changed = true;
        }
        if (fragment && existing.fragment !== fragment) {
          existing.fragment = fragment;
          changed = true;
        }
        if (typeof op.automatic === 'boolean' && existing.automatic !== op.automatic) {
          existing.automatic = op.automatic;
          changed = true;
        }
        if (typeof op.unread === 'boolean' && existing.unread !== op.unread) {
          existing.unread = op.unread;
          changed = true;
        }
        if (replaced) {
          const idx = targetWin.items.indexOf(replaced);
          if (idx >= 0) targetWin.items.splice(idx, 1);
          removeKeyFromOrder(targetWin.order, replaceKey);
          if (targetWin.activeKey === replaceKey) targetWin.activeKey = key;
          changed = true;
        }
        existing.updatedAt = now;
      } else if (replaced) {
        const idx = targetWin.items.indexOf(replaced);
        const nextItem = {
          type: 'file',
          key,
          path: op.path,
          paneId: paneId || replaced.paneId || null,
          fragment: fragment ?? replaced.fragment ?? null,
          unread: op.unread === true,
          automatic: typeof op.automatic === 'boolean' ? op.automatic : Boolean(replaced.automatic),
          updatedAt: now,
        };
        targetWin.items.splice(idx, 1, nextItem);
        const orderIdx = targetWin.order.indexOf(replaceKey);
        if (orderIdx >= 0) targetWin.order[orderIdx] = key;
        else ensureKeyInOrder(targetWin.order, key);
        if (targetWin.activeKey === replaceKey) targetWin.activeKey = key;
        existing = nextItem;
        changed = true;
      } else {
        existing = {
          type: 'file',
          key,
          path: op.path,
          paneId,
          fragment,
          unread: op.unread === true,
          automatic: op.automatic === true,
          updatedAt: now,
        };
        targetWin.items.push(existing);
        ensureKeyInOrder(targetWin.order, key);
        changed = true;
      }

      if (op.activate === true || (!targetWin.activeKey && op.activate !== false)) {
        if (targetWin.activeKey !== key) {
          targetWin.activeKey = key;
          changed = true;
        }
        if (op.keepUnread !== true && existing.unread) {
          existing.unread = false;
          changed = true;
        }
      }
      trimWindowItems(targetWin);
    } else if (op.type === 'remove-file') {
      if (!isValidPath(op.path)) throw validationError('invalid_path');
      if (win) {
        const key = 'file:' + op.path;
        const before = win.items.length;
        win.items = win.items.filter((item) => item.key !== key);
        if (win.items.length !== before) {
          removeKeyFromOrder(win.order, key);
          win.activeKey = fallbackActiveKey(win, key);
          changed = true;
        }
        if (win.items.length === 0) {
          delete this._state.windows[windowId];
          win = null;
        }
      }
    } else if (op.type === 'upsert-block') {
      if (!KIND_RE.test(String(op.kind || ''))) throw validationError('invalid_kind');
      const rawPersistKey = op.persistKey || (typeof op.key === 'string' && op.key.startsWith('block:') ? op.key.slice(6) : op.key);
      if (!isValidKeyString(rawPersistKey)) throw validationError('invalid_persist_key');
      const params = normalizeParams(op.params);
      const mode = op.mode != null ? normalizeMode(op.mode) : 'dock';
      const targetWin = ensureWin();
      const key = 'block:' + rawPersistKey;
      let existing = targetWin.items.find((item) => item.key === key);
      if (existing) {
        const nextParams = JSON.stringify(params);
        if (JSON.stringify(existing.params) !== nextParams) {
          existing.params = params;
          changed = true;
        }
        if (existing.mode !== mode) {
          existing.mode = mode;
          changed = true;
        }
        if (typeof op.unread === 'boolean' && existing.unread !== op.unread) {
          existing.unread = op.unread;
          changed = true;
        }
        const arrivalId = typeof op.arrivalId === 'string' ? normalizeText(op.arrivalId, 64) : existing.arrivalId;
        if (arrivalId !== existing.arrivalId) {
          existing.arrivalId = arrivalId;
          changed = true;
        }
        existing.updatedAt = now;
      } else {
        existing = {
          type: 'block',
          key,
          kind: op.kind,
          persistKey: rawPersistKey,
          params,
          mode,
          unread: op.unread === true,
          arrivalId: typeof op.arrivalId === 'string' ? normalizeText(op.arrivalId, 64) : null,
          updatedAt: now,
        };
        targetWin.items.push(existing);
        ensureKeyInOrder(targetWin.order, key);
        changed = true;
      }
      if (op.activate === true || (!targetWin.activeKey && op.activate !== false)) {
        if (targetWin.activeKey !== key) {
          targetWin.activeKey = key;
          changed = true;
        }
        if (op.keepUnread !== true && op.unread !== true && existing.unread) {
          existing.unread = false;
          changed = true;
        }
      }
      trimWindowItems(targetWin);
    } else if (op.type === 'remove-block') {
      const rawPersistKey = op.persistKey || (typeof op.key === 'string' && op.key.startsWith('block:') ? op.key.slice(6) : op.key);
      if (!isValidKeyString(rawPersistKey)) throw validationError('invalid_persist_key');
      if (win) {
        const key = 'block:' + rawPersistKey;
        const before = win.items.length;
        win.items = win.items.filter((item) => item.key !== key);
        if (win.items.length !== before) {
          removeKeyFromOrder(win.order, key);
          win.activeKey = fallbackActiveKey(win, key);
          changed = true;
        }
        if (win.items.length === 0) {
          delete this._state.windows[windowId];
          win = null;
        }
      }
    } else if (op.type === 'reorder') {
      if (!Array.isArray(op.order)) throw validationError('invalid_order');
      const nextOrder = [];
      for (const k of op.order) {
        if (isValidKeyString(k) && !nextOrder.includes(k)) nextOrder.push(k);
        if (nextOrder.length >= MAX_ORDER) break;
      }
      if (win) {
        if (JSON.stringify(win.order) !== JSON.stringify(nextOrder)) {
          win.order = nextOrder;
          win.items = reorderItems(win.items, nextOrder);
          changed = true;
        }
      } else if (nextOrder.length > 0) {
        const targetWin = ensureWin();
        targetWin.order = nextOrder;
        changed = true;
      }
    } else if (op.type === 'activate') {
      const key = op.key == null ? null : String(op.key);
      if (key !== null && !isValidKeyString(key)) throw validationError('invalid_key');
      if (win) {
        const match = key ? win.items.find((item) => item.key === key) : null;
        if (win.activeKey !== key) {
          win.activeKey = key;
          changed = true;
        }
        if (match && op.keepUnread !== true && match.unread) {
          match.unread = false;
          changed = true;
        }
      } else if (key && key.startsWith('block:')) {
        const targetWin = ensureWin();
        targetWin.activeKey = key;
        changed = true;
      }
    } else if (op.type === 'ack') {
      if (!isValidKeyString(op.key)) throw validationError('invalid_key');
      if (win) {
        const match = win.items.find((item) => item.key === op.key);
        if (match && match.unread) {
          match.unread = false;
          changed = true;
        }
      }
    } else {
      throw validationError('unsupported_op_type');
    }

    if (changed) {
      if (win) {
        win.revision += 1;
        win.updatedAt = now;
      }
      this._state.revision += 1;
    }

    return {
      changed,
      instanceId: this._state.instanceId,
      revision: this._state.revision,
      windowId,
      window: clone(this._state.windows[windowId] || null),
    };
  }

  applyServerBlockOp(op, _meta = {}) {
    if (!isPlainObject(op) || typeof op.type !== 'string') {
      return Promise.reject(validationError('invalid_op'));
    }
    return this._enqueue(async () => {
      const result = this._applyServerBlockOpUnsafe(op);
      if (result.changed) await this._writeUnsafe();
      return result;
    });
  }

  _applyServerBlockOpUnsafe(op) {
    const sb = this._state.serverBlocks;
    const now = this._now();
    let changed = false;

    if (op.type === 'upsert-block') {
      if (!KIND_RE.test(String(op.kind || ''))) throw validationError('invalid_kind');
      const rawPersistKey = op.persistKey || (typeof op.key === 'string' && op.key.startsWith('block:') ? op.key.slice(6) : op.key);
      if (!isValidKeyString(rawPersistKey)) throw validationError('invalid_persist_key');
      const params = normalizeParams(op.params);
      const mode = op.mode != null ? normalizeMode(op.mode) : 'dock';
      const key = 'block:' + rawPersistKey;
      let existing = sb.items.find((item) => item.key === key);
      if (existing) {
        if (JSON.stringify(existing.params) !== JSON.stringify(params)) {
          existing.params = params;
          changed = true;
        }
        if (existing.mode !== mode) {
          existing.mode = mode;
          changed = true;
        }
        if (typeof op.unread === 'boolean' && existing.unread !== op.unread) {
          existing.unread = op.unread;
          changed = true;
        }
        existing.updatedAt = now;
      } else {
        existing = {
          type: 'block',
          key,
          kind: op.kind,
          persistKey: rawPersistKey,
          params,
          mode,
          unread: op.unread === true,
          arrivalId: typeof op.arrivalId === 'string' ? normalizeText(op.arrivalId, 64) : null,
          updatedAt: now,
        };
        sb.items.push(existing);
        if (sb.items.length > MAX_SERVER_BLOCKS) sb.items.splice(0, sb.items.length - MAX_SERVER_BLOCKS);
        changed = true;
      }
      if (op.activate === true || (!sb.activeKey && op.activate !== false)) {
        if (sb.activeKey !== key) {
          sb.activeKey = key;
          changed = true;
        }
      }
    } else if (op.type === 'remove-block') {
      const rawPersistKey = op.persistKey || (typeof op.key === 'string' && op.key.startsWith('block:') ? op.key.slice(6) : op.key);
      if (!isValidKeyString(rawPersistKey)) throw validationError('invalid_persist_key');
      const key = 'block:' + rawPersistKey;
      const before = sb.items.length;
      sb.items = sb.items.filter((item) => item.key !== key);
      if (sb.items.length !== before) {
        if (sb.activeKey === key) sb.activeKey = sb.items.length ? sb.items[sb.items.length - 1].key : null;
        changed = true;
      }
    } else if (op.type === 'activate') {
      const key = op.key == null ? null : String(op.key);
      if (key !== null && !isValidKeyString(key)) throw validationError('invalid_key');
      const next = key && sb.items.some((item) => item.key === key) ? key : null;
      if (sb.activeKey !== next) {
        sb.activeKey = next;
        changed = true;
      }
    } else if (op.type === 'reorder') {
      if (!Array.isArray(op.order)) throw validationError('invalid_order');
      const nextItems = reorderItems(sb.items, op.order.filter((k) => isValidKeyString(k)).slice(0, MAX_ORDER));
      if (JSON.stringify(nextItems.map((i) => i.key)) !== JSON.stringify(sb.items.map((i) => i.key))) {
        sb.items = nextItems;
        changed = true;
      }
    } else {
      throw validationError('unsupported_op_type');
    }

    if (changed) {
      sb.revision += 1;
      this._state.revision += 1;
    }

    return {
      changed,
      instanceId: this._state.instanceId,
      revision: this._state.revision,
      serverBlocks: clone(sb),
    };
  }

  applyNoticeOp(op, _meta = {}) {
    if (!isPlainObject(op) || typeof op.type !== 'string') {
      return Promise.reject(validationError('invalid_op'));
    }
    return this._enqueue(async () => {
      const result = this._applyNoticeOpUnsafe(op);
      if (result.changed) await this._writeUnsafe();
      return result;
    });
  }

  _applyNoticeOpUnsafe(op) {
    const now = this._now();
    let changed = false;

    if (op.type === 'upsert') {
      const entry = normalizeNotice(op.notice, now);
      const key = noticeMergeKey(entry);
      const previous = this._state.notices.find((n) => noticeMergeKey(n) === key);
      if (previous && entry.type === 'git' && !op.force
        && (previous.commit === entry.commit || (entry.commit === 'WORKTREE' && previous.reminderSeen))) {
        return {
          changed: false,
          instanceId: this._state.instanceId,
          revision: this._state.revision,
          notices: clone(this._state.notices),
          notice: clone(previous),
        };
      }
      if (previous && entry.read == null && previous.read) {
        entry.read = true;
        entry.readAt = previous.readAt;
      }
      this._state.notices = this._state.notices.filter((n) => n.id !== entry.id && noticeMergeKey(n) !== key);
      this._state.notices.unshift(entry);
      if (this._state.notices.length > MAX_NOTICES) this._state.notices = this._state.notices.slice(0, MAX_NOTICES);
      changed = true;
    } else if (op.type === 'mark-read') {
      for (const n of this._state.notices) {
        const byId = op.id && n.id === op.id;
        const byView = op.path && n.path === op.path
          && (!op.noticeType || n.type === op.noticeType)
          && (!op.instanceId || (n.target && n.target.instanceId === op.instanceId))
          && (!op.windowId || (n.target && n.target.windowId === op.windowId))
          && (n.type !== 'git' || !op.commit || n.commit === op.commit);
        if ((byId || byView) && !n.read) {
          n.read = true;
          n.readAt = now;
          changed = true;
        }
      }
    } else if (op.type === 'dismiss-window') {
      for (const n of this._state.notices) {
        const matchTarget = op.instanceId && op.windowId && n.target
          && n.target.instanceId === op.instanceId && n.target.windowId === op.windowId;
        const matchId = op.id && n.id === op.id;
        if ((matchTarget || matchId) && !n.reminderSeen) {
          n.reminderSeen = true;
          changed = true;
        }
      }
    } else if (op.type === 'clear') {
      if (this._state.notices.length > 0) {
        this._state.notices = [];
        changed = true;
      }
    } else {
      throw validationError('unsupported_op_type');
    }

    if (changed) this._state.revision += 1;

    return {
      changed,
      instanceId: this._state.instanceId,
      revision: this._state.revision,
      notices: clone(this._state.notices),
    };
  }

  recordFileArrival(arrival) {
    if (!isPlainObject(arrival) || !isValidPath(arrival.path)) {
      return Promise.reject(validationError('invalid_arrival'));
    }
    if (!WINDOW_ID_RE.test(String(arrival.windowId || ''))) {
      return Promise.reject(validationError('invalid_window_id'));
    }
    return this._enqueue(async () => {
      if (arrival.instanceId && this._state.instanceId && arrival.instanceId !== this._state.instanceId) {
        this._setServerInstanceUnsafe(arrival.instanceId);
      } else if (arrival.instanceId && !this._state.instanceId) {
        this._state.instanceId = arrival.instanceId;
      }

      const activate = arrival.activate !== false;
      const existingWin = this._state.windows[arrival.windowId];
      let winResult = { changed: false, window: clone(existingWin || null) };

      if (activate || (existingWin && existingWin.items.length > 0)) {
        winResult = this._applyWindowOpUnsafe(arrival.windowId, {
          type: 'upsert-file',
          path: arrival.path,
          paneId: arrival.paneId || null,
          replaces: arrival.replaces || null,
          fragment: arrival.fragment || null,
          automatic: arrival.automatic !== false,
          unread: true,
          activate,
          keepUnread: true,
        }, {
          instanceId: arrival.instanceId,
          sessionName: arrival.sessionName,
          windowIndex: arrival.windowIndex,
          windowName: arrival.windowName,
        });
      }

      let notice = null;
      if (activate) {
        const name = arrival.path.split('/').pop();
        const kindLabels = { draft: '草稿', spec: '设计', plan: '计划', progress: '进度' };
        const label = kindLabels[arrival.kind] || '文档';
        const res = this._applyNoticeOpUnsafe({
          type: 'upsert',
          force: true,
          notice: {
            id: 'doc-' + encodeURIComponent([arrival.instanceId || this._state.instanceId || '', arrival.windowId, arrival.path].join('\u0000')),
            type: 'document',
            path: arrival.path,
            paneId: arrival.paneId || null,
            fragment: arrival.fragment || null,
            message: `新${label}：${name}`,
            read: false,
            reminderSeen: false,
            session: arrival.sessionName || '',
            windowIndex: arrival.windowIndex ?? null,
            windowName: arrival.windowName || '',
            target: {
              instanceId: arrival.instanceId || this._state.instanceId || '',
              windowId: arrival.windowId,
              sessionId: arrival.sessionId || '',
              paneId: arrival.paneId || null,
            },
          },
        });
        notice = res.notice || this._state.notices[0] || null;
      }

      if (winResult.changed || notice) await this._writeUnsafe();

      return {
        revision: this._state.revision,
        instanceId: this._state.instanceId,
        windowId: arrival.windowId,
        window: winResult.window,
        notice: clone(notice),
      };
    });
  }

  recordGitArrival(arrival) {
    if (!isPlainObject(arrival) || !isValidPath(arrival.path)) {
      return Promise.reject(validationError('invalid_arrival'));
    }
    if (!WINDOW_ID_RE.test(String(arrival.windowId || ''))) {
      return Promise.reject(validationError('invalid_window_id'));
    }
    return this._enqueue(async () => {
      if (arrival.instanceId && this._state.instanceId && arrival.instanceId !== this._state.instanceId) {
        this._setServerInstanceUnsafe(arrival.instanceId);
      } else if (arrival.instanceId && !this._state.instanceId) {
        this._state.instanceId = arrival.instanceId;
      }

      const activate = arrival.activate !== false;
      const isWorktree = arrival.commit === 'WORKTREE';
      let winResult = { changed: false, window: clone(this._state.windows[arrival.windowId] || null) };

      // Strict CLAUDE.md contract: background / WORKTREE arrivals (activate: false)
      // never create or mutate a Git block; only explicit opens create/update it.
      if (activate) {
        const params = isWorktree ? { path: arrival.path } : { path: arrival.path, commit: arrival.commit };
        winResult = this._applyWindowOpUnsafe(arrival.windowId, {
          type: 'upsert-block',
          kind: 'git',
          persistKey: 'git:' + arrival.path,
          params,
          mode: 'dock',
          unread: true,
          arrivalId: String(this._now()) + '-srv',
          activate: true,
          keepUnread: true,
        }, {
          instanceId: arrival.instanceId,
          sessionName: arrival.sessionName,
          windowIndex: arrival.windowIndex,
          windowName: arrival.windowName,
        });
      }

      const short = String(arrival.commit || '').slice(0, 8);
      const message = isWorktree
        ? `工作区有 ${arrival.dirtyCount ? arrival.dirtyCount + ' 处' : ''}待审阅变更`
        : (activate ? `提交预览已加入侧栏：${short}` : `有新提交待查看：${short}`);

      const noticeRes = this._applyNoticeOpUnsafe({
        type: 'upsert',
        notice: {
          id: 'git-' + encodeURIComponent([arrival.instanceId || this._state.instanceId || '', arrival.windowId, arrival.path, arrival.commit || ''].join('\u0000')),
          type: 'git',
          path: arrival.path,
          paneId: arrival.paneId || null,
          commit: arrival.commit || null,
          dirtyCount: arrival.dirtyCount ?? null,
          message,
          read: false,
          reminderSeen: false,
          session: arrival.sessionName || '',
          windowIndex: arrival.windowIndex ?? null,
          windowName: arrival.windowName || '',
          target: {
            instanceId: arrival.instanceId || this._state.instanceId || '',
            windowId: arrival.windowId,
            sessionId: arrival.sessionId || '',
            paneId: arrival.paneId || null,
          },
        },
      });

      if (winResult.changed || noticeRes.changed) await this._writeUnsafe();

      return {
        revision: this._state.revision,
        instanceId: this._state.instanceId,
        windowId: arrival.windowId,
        window: winResult.window,
        notice: clone(noticeRes.notice || this._state.notices[0] || null),
      };
    });
  }

  importLegacy(payload = {}) {
    if (!isPlainObject(payload)) return Promise.reject(validationError('invalid_import_payload'));
    return this._enqueue(async () => {
      if (payload.instanceId && this._state.instanceId && payload.instanceId !== this._state.instanceId) {
        return { changed: false, stale: true, ...this.getSnapshot() };
      }
      if (payload.instanceId && !this._state.instanceId) {
        this._state.instanceId = String(payload.instanceId);
      }

      let changed = false;
      if (isPlainObject(payload.windows)) {
        for (const [windowId, rawWin] of Object.entries(payload.windows)) {
          if (!WINDOW_ID_RE.test(windowId)) continue;
          if (this._state.windows[windowId] && this._state.windows[windowId].items.length > 0) continue;
          const sanitized = sanitizeLoadedWindow(rawWin);
          if (sanitized) {
            sanitized.revision = 1;
            this._state.windows[windowId] = sanitized;
            changed = true;
          }
        }
      }

      if (payload.serverBlocks && this._state.serverBlocks.items.length === 0) {
        const sanitizedBlocks = sanitizeServerBlocks(payload.serverBlocks);
        if (sanitizedBlocks.items.length > 0) {
          sanitizedBlocks.revision = 1;
          this._state.serverBlocks = sanitizedBlocks;
          changed = true;
        }
      }

      if (Array.isArray(payload.notices)) {
        const existingKeys = new Set(this._state.notices.map(noticeMergeKey));
        for (const rawNotice of payload.notices) {
          try {
            const notice = normalizeNotice(rawNotice, this._now());
            if (notice.target && this._state.instanceId && notice.target.instanceId !== this._state.instanceId) continue;
            const key = noticeMergeKey(notice);
            if (existingKeys.has(key)) continue;
            existingKeys.add(key);
            this._state.notices.push(notice);
            changed = true;
          } catch { /* skip invalid */ }
        }
        if (this._state.notices.length > MAX_NOTICES) {
          this._state.notices = this._state.notices
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, MAX_NOTICES);
        }
      }

      if (changed) {
        this._state.revision += 1;
        await this._writeUnsafe();
      }
      return { changed, ...this.getSnapshot() };
    });
  }

  forgetWindow(windowId) {
    if (!WINDOW_ID_RE.test(String(windowId || ''))) return Promise.resolve({ changed: false });
    return this._enqueue(async () => {
      let changed = false;
      if (this._state.windows[windowId]) {
        delete this._state.windows[windowId];
        changed = true;
      }
      const beforeNotices = this._state.notices.length;
      this._state.notices = this._state.notices.filter((n) => !n.target || n.target.windowId !== windowId);
      if (this._state.notices.length !== beforeNotices) changed = true;
      if (changed) {
        this._state.revision += 1;
        await this._writeUnsafe();
      }
      return { changed, revision: this._state.revision };
    });
  }

  forgetSessionWindows(windowIds) {
    const ids = new Set((Array.isArray(windowIds) ? windowIds : []).filter((id) => WINDOW_ID_RE.test(String(id || ''))));
    if (ids.size === 0) return Promise.resolve({ changed: false });
    return this._enqueue(async () => {
      let changed = false;
      for (const id of ids) {
        if (this._state.windows[id]) {
          delete this._state.windows[id];
          changed = true;
        }
      }
      const beforeNotices = this._state.notices.length;
      this._state.notices = this._state.notices.filter((n) => !n.target || !ids.has(n.target.windowId));
      if (this._state.notices.length !== beforeNotices) changed = true;
      if (changed) {
        this._state.revision += 1;
        await this._writeUnsafe();
      }
      return { changed, revision: this._state.revision };
    });
  }

  sweepLiveWindows(instanceId, liveWindowIds, windowMetaById = null) {
    if (!instanceId || !(liveWindowIds instanceof Set)) return Promise.resolve({ changed: false });
    return this._enqueue(async () => {
      if (this._state.instanceId && this._state.instanceId !== instanceId) {
        this._setServerInstanceUnsafe(instanceId);
        await this._writeUnsafe();
        return { changed: true, revision: this._state.revision };
      }
      if (!this._state.instanceId) this._state.instanceId = instanceId;
      let changed = false;
      for (const windowId of Object.keys(this._state.windows)) {
        if (!liveWindowIds.has(windowId)) {
          delete this._state.windows[windowId];
          changed = true;
        } else if (windowMetaById && windowMetaById.has(windowId)) {
          const meta = windowMetaById.get(windowId);
          const win = this._state.windows[windowId];
          if (meta.sessionName && win.sessionName !== meta.sessionName) { win.sessionName = meta.sessionName; changed = true; }
          if (meta.windowIndex !== undefined && win.windowIndex !== meta.windowIndex) { win.windowIndex = meta.windowIndex; changed = true; }
          if (meta.windowName && win.windowName !== meta.windowName) { win.windowName = meta.windowName; changed = true; }
        }
      }
      const beforeNotices = this._state.notices.length;
      this._state.notices = this._state.notices.filter((n) => !n.target || n.target.instanceId !== instanceId || liveWindowIds.has(n.target.windowId));
      if (this._state.notices.length !== beforeNotices) changed = true;
      if (changed) {
        this._state.revision += 1;
        await this._writeUnsafe();
      }
      return { changed, revision: this._state.revision };
    });
  }

  migrateRestoredWindows(nextInstanceId, mappings = []) {
    if (!nextInstanceId || !Array.isArray(mappings) || mappings.length === 0) {
      return Promise.resolve({ migratedWindows: 0, migratedNotices: 0, revision: this._state.revision });
    }
    return this._enqueue(async () => {
      if (this._state.instanceId !== nextInstanceId) {
        this._setServerInstanceUnsafe(nextInstanceId);
      }
      const cutoff = this._now() - ARCHIVE_TTL_MS;
      const validArchives = this._state.archivedInstances.filter((entry) => Number(entry.archivedAt) > cutoff);
      const archive = validArchives[validArchives.length - 1];
      if (!archive) {
        return { migratedWindows: 0, migratedNotices: 0, revision: this._state.revision };
      }

      const archiveWindows = archive.windows || {};
      const archiveNotices = Array.isArray(archive.notices) ? archive.notices : [];
      const consumedWinIds = new Set();
      let migratedWindows = 0;
      let migratedNotices = 0;

      for (const map of mappings) {
        if (!map || !WINDOW_ID_RE.test(String(map.newWindowId || ''))) continue;
        let sourceWinId = null;
        if (map.origWindowId && archiveWindows[map.origWindowId] && !consumedWinIds.has(map.origWindowId)) {
          sourceWinId = map.origWindowId;
        } else {
          for (const [id, win] of Object.entries(archiveWindows)) {
            if (consumedWinIds.has(id)) continue;
            if (win.sessionName && win.sessionName === map.sessionName
              && win.windowIndex != null && String(win.windowIndex) === String(map.windowIndex)) {
              sourceWinId = id;
              break;
            }
          }
        }
        if (!sourceWinId) continue;
        consumedWinIds.add(sourceWinId);

        const sourceWin = archiveWindows[sourceWinId];
        if (!this._state.windows[map.newWindowId] || this._state.windows[map.newWindowId].items.length === 0) {
          const cloned = clone(sourceWin);
          cloned.sessionName = normalizeText(map.restoredSessionName || map.sessionName || cloned.sessionName);
          cloned.windowIndex = normalizeWindowIndex(map.windowIndex ?? cloned.windowIndex);
          cloned.windowName = normalizeText(map.windowName || cloned.windowName);
          cloned.updatedAt = this._now();
          cloned.revision = (cloned.revision || 0) + 1;
          for (const item of cloned.items) {
            if (item.type === 'file') item.paneId = null;
            if (item.type === 'block' && item.params && 'paneId' in item.params) {
              item.params = { ...item.params, paneId: null };
            }
          }
          this._state.windows[map.newWindowId] = cloned;
          migratedWindows += 1;
        }

        for (const notice of archiveNotices) {
          if (!notice.target || notice.target.windowId !== sourceWinId) continue;
          const migrated = clone(notice);
          migrated.paneId = null;
          migrated.session = normalizeText(map.restoredSessionName || map.sessionName || migrated.session, 128);
          migrated.windowIndex = normalizeWindowIndex(map.windowIndex ?? migrated.windowIndex);
          migrated.windowName = normalizeText(map.windowName || migrated.windowName, 128);
          migrated.target = {
            ...migrated.target,
            instanceId: nextInstanceId,
            windowId: map.newWindowId,
            paneId: null,
          };
          migrated.id = `${migrated.type === 'git' ? 'git' : 'doc'}-${encodeURIComponent([nextInstanceId, map.newWindowId, migrated.path, migrated.commit || ''].join('\u0000'))}`;
          const mergeKey = noticeMergeKey(migrated);
          if (!this._state.notices.some((n) => noticeMergeKey(n) === mergeKey)) {
            this._state.notices.push(migrated);
            migratedNotices += 1;
          }
        }
      }

      if (this._state.notices.length > MAX_NOTICES) {
        this._state.notices = this._state.notices
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, MAX_NOTICES);
      }

      for (const usedId of consumedWinIds) delete archiveWindows[usedId];
      archive.notices = archiveNotices.filter((n) => !n.target || !consumedWinIds.has(n.target.windowId));
      if (Object.keys(archiveWindows).length === 0 && archive.notices.length === 0) {
        this._state.archivedInstances = this._state.archivedInstances.filter((entry) => entry !== archive);
      }

      if (migratedWindows > 0 || migratedNotices > 0) {
        this._state.revision += 1;
        await this._writeUnsafe();
      }
      return { migratedWindows, migratedNotices, revision: this._state.revision };
    });
  }

  _enqueue(fn) {
    const next = this._queue.then(fn, fn);
    this._queue = next.catch(() => {});
    return next;
  }

  async _writeUnsafe() {
    await mkdir(dirname(this.filePath), { recursive: true, mode: DIR_MODE });
    const tmp = `${this.filePath}.tmp.${process.pid}`;
    await replaceFileWrite(tmp, this.filePath, JSON.stringify(this._state));
  }
}

async function replaceFileWrite(tmpPath, targetPath, contents) {
  await writeFile(tmpPath, contents, { mode: FILE_MODE });
  await replaceFile(tmpPath, targetPath);
}
