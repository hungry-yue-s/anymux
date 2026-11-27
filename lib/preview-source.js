import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathSpace } from './agent-docs/project.js';

const execFileAsync = promisify(execFile);
const VALID_PANE_SOURCES = new Set(['arg', 'env', 'none']);
const THREAD_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const CODEX_CMD_RE = /^codex(?:-tui|-cli)?(?:\.exe)?$/i;
const MAX_GUIDED_CANDIDATES = 12;

function fail(message, status = 409) {
  throw Object.assign(new Error(message), { status });
}

function parseServerPid(instanceId) {
  const match = /^(\d+):/.exec(String(instanceId || ''));
  return match ? match[1] : '';
}

function normalizeServerPid(raw) {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? String(raw) : '';
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return /^\d+$/.test(trimmed) && Number(trimmed) > 0 ? trimmed : '';
  }
  return '';
}

function normalizeCallerPid(raw) {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 1 ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 1 ? parsed : null;
  }
  return null;
}

function normalizeCodexThreadId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return THREAD_ID_RE.test(trimmed) ? trimmed : null;
}

function normalizeCwdKey(cwd) {
  const normalized = typeof cwd === 'string' && cwd.length <= 4096 && !/[\x00-\x1f\x7f]/.test(cwd)
    ? pathSpace.toApi(cwd) : '';
  return normalized.startsWith('/') ? pathSpace.key(pathSpace.resolve(normalized)) : '';
}

async function defaultGetAncestorPids(pid) {
  if (process.platform === 'win32') return null;
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid='], {
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const ppidMap = new Map();
    for (const line of String(stdout || '').split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) continue;
      ppidMap.set(Number(match[1]), Number(match[2]));
    }
    if (!ppidMap.has(pid)) return null;
    const ancestors = [];
    const seen = new Set();
    let cur = pid;
    for (let i = 0; i < 32 && cur > 1 && !seen.has(cur); i++) {
      seen.add(cur);
      ancestors.push(cur);
      if (!ppidMap.has(cur)) break;
      cur = ppidMap.get(cur);
    }
    return ancestors;
  } catch {
    return null;
  }
}

async function defaultReadCodexThread(threadId) {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  let dbPath = null;
  try {
    const entries = await readdir(codexHome);
    const states = entries
      .map((name) => ({ name, match: /^state_(\d+)\.sqlite$/.exec(name) }))
      .filter((item) => item.match)
      .sort((a, b) => Number(b.match[1]) - Number(a.match[1]));
    if (!states.length) return null;
    dbPath = join(codexHome, states[0].name);
  } catch {
    return null;
  }
  let db = null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT id, cwd, name, title FROM threads WHERE id = ? LIMIT 1').get(threadId);
    if (!row) return null;
    return {
      id: row.id,
      cwd: typeof row.cwd === 'string' ? row.cwd : '',
      name: typeof row.name === 'string' ? row.name : '',
      title: typeof row.title === 'string' ? row.title : '',
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function buildLivePanes(tree, commands = []) {
  const cmdByPane = new Map();
  for (const cmd of commands || []) {
    if (cmd?.paneId) cmdByPane.set(cmd.paneId, cmd);
  }
  const panes = [];
  for (const session of tree.sessions || []) {
    for (const win of session.windows || []) {
      for (const pane of win.panes || []) {
        if (!pane?.id) continue;
        const cmd = cmdByPane.get(pane.id);
        panes.push({
          sessionId: session.id || '',
          sessionName: session.name || '',
          windowId: win.id,
          windowName: win.name || '',
          windowIndex: win.index ?? cmd?.windowIndex ?? null,
          paneId: pane.id,
          paneIndex: pane.index ?? null,
          command: pane.command || cmd?.command || '',
          label: pane.label || cmd?.label || '',
          path: pane.cwd || cmd?.path || '',
          title: pane.title || cmd?.title || '',
          pid: Number(cmd?.pid || 0),
        });
      }
    }
  }
  return panes;
}

function paneCwdKey(pane) {
  return normalizeCwdKey(pane?.path);
}

function isCodexPane(pane) {
  return CODEX_CMD_RE.test(String(pane?.command || '').trim());
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function matchesThreadName(paneTitle, threadName) {
  const normTitle = normalizeWhitespace(paneTitle);
  const normName = normalizeWhitespace(threadName);
  if (!normTitle || !normName || normName.length < 2) return false;
  return normTitle.includes(normName);
}

function truncateField(value, max) {
  const clean = normalizeWhitespace(value);
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '…';
}

function quoteField(value, max = 120) {
  return JSON.stringify(truncateField(value, max));
}

function formatCandidatePanes(panes, { cwdKey = '', preferCodex = false, max = MAX_GUIDED_CANDIDATES } = {}) {
  if (!panes.length) return ['  (no live panes found)'];
  const ranked = panes
    .map((pane, idx) => ({
      pane,
      idx,
      score: (preferCodex && isCodexPane(pane) ? 4 : 0)
        + (cwdKey && paneCwdKey(pane) === cwdKey ? 2 : 0)
        + (pane.title ? 1 : 0),
    }))
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
    .map((entry) => entry.pane);
  const shown = ranked.slice(0, max);
  const lines = shown.map((pane) => {
    const parts = [
      `  ${pane.paneId}`,
      `session=${quoteField(pane.sessionName || pane.sessionId, 60)}`,
      `window=${quoteField(pane.windowName || pane.windowId, 60)} (${pane.windowId})`,
      `idx=${pane.paneIndex ?? '?'}`,
      `cmd=${normalizeWhitespace(pane.command) || '?'}`,
    ];
    if (pane.label) parts.push(`label=${quoteField(pane.label, 40)}`);
    if (pane.path) parts.push(`cwd=${quoteField(pane.path, 160)}`);
    if (pane.title) parts.push(`title=${quoteField(pane.title, 120)}`);
    return parts.join(' | ');
  });
  if (ranked.length > shown.length) {
    lines.push(`  ... and ${ranked.length - shown.length} more live panes`);
  }
  return lines;
}

function failWithGuidance(code, reason, panes, opts) {
  const lines = [
    `${code}: ${reason}`,
    'ACTION REQUIRED: identify your own pane from the live candidates below (by window name, pane title, command, or cwd) and retry once with explicit --pane %N:',
    ...formatCandidatePanes(panes, opts),
  ];
  fail(lines.join('\n'), 409);
}

/** Validate CLI provenance; verify pane ancestry and guide retries on ambiguity. */
export async function resolvePreviewSource(
  { workspace, tmux, getAncestorPids = defaultGetAncestorPids, readCodexThread = defaultReadCodexThread },
  source = {},
) {
  const { paneId = null, cwd, paneSource } = source || {};
  if (paneSource != null && !VALID_PANE_SOURCES.has(paneSource)) {
    fail('invalid_pane_source', 400);
  }
  const tree = await workspace.getWorkspace();
  if (!tree?.instanceId) fail('preview_source_unavailable: tmux workspace unavailable', 503);
  const windows = (tree.sessions || []).flatMap(session => session.windows || []);
  const known = paneId && windows.find(win => (win.panes || []).some(pane => pane.id === paneId));

  const liveServerPid = parseServerPid(tree.instanceId);
  const tmuxServerPid = normalizeServerPid(source?.tmuxServerPid);
  const callerPid = normalizeCallerPid(source?.callerPid);
  const codexThreadId = normalizeCodexThreadId(source?.codexThreadId);
  const cwdKey = normalizeCwdKey(cwd);
  const staleServerPid = Boolean(tmuxServerPid && liveServerPid && tmuxServerPid !== liveServerPid);

  let cachedLivePanes = null;
  const loadLivePanes = async () => {
    if (cachedLivePanes) return cachedLivePanes;
    if (tree.complete === false) fail('preview_source_unavailable: incomplete tmux workspace; retry', 503);
    const commands = (await Promise.all((tree.sessions || []).map(session => tmux.listPaneCommands(session.id)))).flat();
    if (await tmux.getServerInstance() !== tree.instanceId) fail('preview_source_changed: tmux restarted; retry');
    cachedLivePanes = buildLivePanes(tree, commands);
    return cachedLivePanes;
  };

  if (paneSource === 'arg') {
    if (known) return { paneId, windowId: known.id, instanceId: tree.instanceId };
    const panes = tree.complete === false ? buildLivePanes(tree) : await loadLivePanes();
    failWithGuidance(
      'preview_source_invalid_pane',
      `explicit --pane ${paneId || '(none)'} does not exist in the current tmux server; retry with --pane %N`,
      panes,
      { cwdKey, preferCodex: Boolean(codexThreadId) },
    );
  }

  // Legacy callers without explicit provenance fields keep the fast path.
  if (paneSource == null && known && !staleServerPid && !callerPid && !codexThreadId) {
    return { paneId, windowId: known.id, instanceId: tree.instanceId };
  }

  const panes = await loadLivePanes();
  let detached = false;
  if (callerPid && panes.length) {
    const paneByPid = new Map();
    for (const pane of panes) {
      if (pane.pid > 1) paneByPid.set(pane.pid, pane);
    }
    const ancestors = await getAncestorPids(callerPid).catch(() => null);
    if (Array.isArray(ancestors) && ancestors.length > 0) {
      for (const pid of ancestors) {
        const ownerPane = paneByPid.get(pid);
        if (ownerPane) return { paneId: ownerPane.paneId, windowId: ownerPane.windowId, instanceId: tree.instanceId };
      }
      if (paneByPid.size > 0) detached = true;
    }
  }

  const knownEntry = known && paneId ? panes.find(pane => pane.paneId === paneId) : null;
  const codexPaneMismatch = Boolean(codexThreadId && knownEntry && knownEntry.command && !isCodexPane(knownEntry));
  const envUntrusted = staleServerPid || detached || codexPaneMismatch;
  if (known && !envUntrusted) return { paneId, windowId: known.id, instanceId: tree.instanceId };

  const untrustedReasons = [];
  if (paneId && known && envUntrusted) {
    if (staleServerPid) untrustedReasons.push(`server pid ${tmuxServerPid} != live ${liveServerPid}`);
    if (detached) untrustedReasons.push(`caller pid ${callerPid} is detached from tmux pane tree`);
    if (codexPaneMismatch) untrustedReasons.push(`pane ${paneId} runs ${knownEntry.command}, not codex`);
  }
  const rejectionPrefix = untrustedReasons.length
    ? `$TMUX_PANE (${paneId}: ${untrustedReasons.join(', ')}) cannot be trusted; `
    : (paneId && !known && (staleServerPid || detached)
      ? `$TMUX_PANE (${paneId}) is not in the live tmux server; `
      : '');

  if (codexThreadId) {
    const thread = await readCodexThread(codexThreadId).catch(() => null);
    const effectiveCwdKey = cwdKey || normalizeCwdKey(thread?.cwd);
    const codexPanes = panes.filter(isCodexPane);
    const cwdCodexPanes = effectiveCwdKey
      ? codexPanes.filter(pane => paneCwdKey(pane) === effectiveCwdKey)
      : codexPanes;
    const titleScope = cwdCodexPanes.length > 0 ? cwdCodexPanes : codexPanes;
    const titleCodexPanes = thread?.name
      ? titleScope.filter(pane => matchesThreadName(pane.title, thread.name))
      : [];

    if (titleCodexPanes.length === 1) {
      return { paneId: titleCodexPanes[0].paneId, windowId: titleCodexPanes[0].windowId, instanceId: tree.instanceId };
    }
    if (titleCodexPanes.length === 0 && cwdCodexPanes.length === 1) {
      return { paneId: cwdCodexPanes[0].paneId, windowId: cwdCodexPanes[0].windowId, instanceId: tree.instanceId };
    }
    if (titleCodexPanes.length === 0 && cwdCodexPanes.length === 0 && !effectiveCwdKey && codexPanes.length === 1) {
      return { paneId: codexPanes[0].paneId, windowId: codexPanes[0].windowId, instanceId: tree.instanceId };
    }

    const candidates = titleCodexPanes.length > 1
      ? titleCodexPanes
      : cwdCodexPanes.length > 1
        ? cwdCodexPanes
        : codexPanes.length
          ? codexPanes
          : panes;
    const code = candidates.length > 1 ? 'preview_source_ambiguous' : 'preview_source_untrusted';
    const reason = `${rejectionPrefix}${candidates.length > 1 ? 'multiple live panes match this Codex session; pass --pane %N' : 'cannot uniquely verify source pane for Codex session; pass --pane %N'}`;
    failWithGuidance(code, reason, candidates, { cwdKey: effectiveCwdKey, preferCodex: true });
  }

  if (!cwdKey) {
    failWithGuidance(
      untrustedReasons.length ? 'preview_source_untrusted' : 'preview_source_unavailable',
      `${rejectionPrefix}pass --pane %N or run from a tmux pane`,
      panes,
      { cwdKey: '' },
    );
  }
  const cwdMatches = panes.filter(pane => paneCwdKey(pane) === cwdKey);
  const windowIds = new Set(cwdMatches.map(pane => pane.windowId));
  if (windowIds.size > 1) {
    failWithGuidance(
      'preview_source_ambiguous',
      `${rejectionPrefix}cwd matches multiple windows; pass --pane %N`,
      cwdMatches,
      { cwdKey },
    );
  }
  if (!windowIds.size) {
    failWithGuidance(
      untrustedReasons.length ? 'preview_source_untrusted' : 'preview_source_unavailable',
      `${rejectionPrefix}no live pane matches cwd; pass --pane %N`,
      panes,
      { cwdKey },
    );
  }
  return { paneId: null, windowId: cwdMatches[0].windowId, instanceId: tree.instanceId };
}
