import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES_PER_PROVIDER = 300;
const PROVIDERS = ['claude', 'codex', 'gemini'];

function defaultDirs(overrides = {}) {
  const home = homedir();
  return {
    claudeDir: overrides.claudeDir || join(home, '.claude', 'projects'),
    codexDir: overrides.codexDir || join(home, '.codex', 'sessions'),
    geminiDir: overrides.geminiDir || join(home, '.gemini', 'tmp'),
  };
}

async function collectFiles(rootDir, matcher) {
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && matcher(entry.name, full)) {
        try {
          const st = await stat(full);
          if (st.size <= MAX_FILE_BYTES) {
            found.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
          }
        } catch {
          /* ignore inaccessible entry */
        }
      }
    }
  }
  await walk(rootDir);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, MAX_FILES_PER_PROVIDER);
}

function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item.text === 'string' && (!item.type || item.type === 'text' || item.type === 'input_text' || item.type === 'output_text')) {
        parts.push(item.text);
      }
    }
    return parts.join('\n').trim();
  }
  return '';
}

function summarizeTitle(text, fallback = '未命名会话') {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  return clean.length > 96 ? clean.slice(0, 96) + '…' : clean;
}

async function readJsonlLines(filePath) {
  const lines = [];
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { lines.push(JSON.parse(trimmed)); } catch { /* skip malformed line */ }
  }
  return lines;
}

async function parseClaudeFile(fileInfo, includeTurns = false) {
  const entries = await readJsonlLines(fileInfo.path);
  let sessionId = basename(fileInfo.path, '.jsonl');
  let cwd = '';
  let gitBranch = '';
  let model = '';
  let title = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let createdAt = null;
  let updatedAt = null;
  const turns = [];

  for (const row of entries) {
    if (row.sessionId) sessionId = String(row.sessionId);
    if (row.cwd && !cwd) cwd = String(row.cwd);
    if (row.gitBranch && !gitBranch) gitBranch = String(row.gitBranch);
    const ts = row.timestamp ? Date.parse(row.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (createdAt === null || ts < createdAt) createdAt = ts;
      if (updatedAt === null || ts > updatedAt) updatedAt = ts;
    }
    const msg = row.message || row;
    if (msg.model) model = String(msg.model);
    if (msg.usage) {
      inputTokens += Number(msg.usage.input_tokens || 0) + Number(msg.usage.cache_read_input_tokens || 0);
      outputTokens += Number(msg.usage.output_tokens || 0);
    }
    const role = row.type === 'user' || msg.role === 'user' ? 'user'
      : (row.type === 'assistant' || msg.role === 'assistant' ? 'assistant' : null);
    if (role) {
      const text = extractText(msg.content ?? row.content);
      if (text) {
        if (role === 'user' && !title) title = summarizeTitle(text);
        if (includeTurns) turns.push({ role, text, timestamp: Number.isFinite(ts) ? ts : updatedAt });
      }
    }
  }

  createdAt ??= fileInfo.mtimeMs;
  updatedAt ??= fileInfo.mtimeMs;

  return {
    session: {
      provider: 'claude',
      id: sessionId,
      title: title || basename(fileInfo.path, '.jsonl'),
      cwd,
      gitBranch,
      model,
      inputTokens,
      outputTokens,
      turnCount: includeTurns ? turns.length : entries.filter((r) => r.type === 'user' || r.type === 'assistant').length,
      createdAt,
      updatedAt,
      resumeCommand: `claude --resume ${sessionId}`,
      filePath: fileInfo.path,
    },
    turns,
  };
}

async function parseCodexFile(fileInfo, includeTurns = false) {
  const entries = await readJsonlLines(fileInfo.path);
  let sessionId = basename(fileInfo.path, '.jsonl');
  let cwd = '';
  let gitBranch = '';
  let model = '';
  let title = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let createdAt = null;
  let updatedAt = null;
  const turns = [];
  let count = 0;

  for (const row of entries) {
    const ts = row.timestamp ? Date.parse(row.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (createdAt === null || ts < createdAt) createdAt = ts;
      if (updatedAt === null || ts > updatedAt) updatedAt = ts;
    }
    if (row.type === 'session_meta' && row.payload) {
      if (row.payload.id) sessionId = String(row.payload.id);
      if (row.payload.cwd) cwd = String(row.payload.cwd);
      if (row.payload.git?.branch) gitBranch = String(row.payload.git.branch);
      if (row.payload.model) model = String(row.payload.model);
    } else if (row.type === 'turn_context' && row.payload) {
      if (row.payload.model) model = String(row.payload.model);
      if (row.payload.cwd && !cwd) cwd = String(row.payload.cwd);
    } else if (row.type === 'event_msg' && row.payload?.type === 'token_count' && row.payload.info?.total_token_usage) {
      const usage = row.payload.info.total_token_usage;
      inputTokens = Math.max(inputTokens, Number(usage.input_tokens || 0) + Number(usage.cached_input_tokens || 0));
      outputTokens = Math.max(outputTokens, Number(usage.output_tokens || 0));
    } else if (row.type === 'response_item' && row.payload?.type === 'message') {
      const role = row.payload.role === 'user' ? 'user' : (row.payload.role === 'assistant' ? 'assistant' : null);
      if (role) {
        const text = extractText(row.payload.content);
        if (text) {
          count += 1;
          if (role === 'user' && !title) title = summarizeTitle(text);
          if (includeTurns) turns.push({ role, text, timestamp: Number.isFinite(ts) ? ts : updatedAt });
        }
      }
    }
  }

  createdAt ??= fileInfo.mtimeMs;
  updatedAt ??= fileInfo.mtimeMs;

  return {
    session: {
      provider: 'codex',
      id: sessionId,
      title: title || sessionId,
      cwd,
      gitBranch,
      model,
      inputTokens,
      outputTokens,
      turnCount: count,
      createdAt,
      updatedAt,
      resumeCommand: `codex resume ${sessionId}`,
      filePath: fileInfo.path,
    },
    turns,
  };
}

async function parseGeminiFile(fileInfo, includeTurns = false) {
  let doc;
  try {
    doc = JSON.parse(await readFile(fileInfo.path, 'utf8'));
  } catch {
    return null;
  }
  const sessionId = String(doc.sessionId || basename(fileInfo.path, '.json'));
  const cwd = String(doc.cwd || doc.projectPath || '');
  let model = String(doc.model || '');
  let title = '';
  let inputTokens = 0;
  let outputTokens = 0;
  const createdAt = doc.startTime ? (Date.parse(doc.startTime) || fileInfo.mtimeMs) : fileInfo.mtimeMs;
  const updatedAt = doc.lastUpdated ? (Date.parse(doc.lastUpdated) || fileInfo.mtimeMs) : fileInfo.mtimeMs;
  const turns = [];
  const messages = Array.isArray(doc.messages) ? doc.messages : [];

  for (const msg of messages) {
    if (msg.model) model = String(msg.model);
    if (msg.tokens) {
      inputTokens += Number(msg.tokens.input || msg.tokens.input_tokens || 0);
      outputTokens += Number(msg.tokens.output || msg.tokens.output_tokens || 0);
    }
    const role = msg.type === 'user' || msg.role === 'user' ? 'user'
      : (msg.type === 'gemini' || msg.type === 'model' || msg.role === 'assistant' ? 'assistant' : null);
    if (role) {
      const text = extractText(msg.content ?? msg.text);
      if (text) {
        if (role === 'user' && !title) title = summarizeTitle(text);
        if (includeTurns) turns.push({ role, text, timestamp: msg.timestamp ? (Date.parse(msg.timestamp) || updatedAt) : updatedAt });
      }
    }
  }

  return {
    session: {
      provider: 'gemini',
      id: sessionId,
      title: title || sessionId,
      cwd,
      gitBranch: '',
      model,
      inputTokens,
      outputTokens,
      turnCount: messages.length,
      createdAt,
      updatedAt,
      resumeCommand: `gemini --resume ${sessionId}`,
      filePath: fileInfo.path,
    },
    turns,
  };
}

async function scanProvider(provider, dirs, { includeTurns = false } = {}) {
  if (provider === 'claude') {
    const files = await collectFiles(dirs.claudeDir, (name) => name.endsWith('.jsonl'));
    return (await Promise.all(files.map((f) => parseClaudeFile(f, includeTurns).catch(() => null)))).filter(Boolean);
  }
  if (provider === 'codex') {
    const files = await collectFiles(dirs.codexDir, (name) => name.endsWith('.jsonl'));
    return (await Promise.all(files.map((f) => parseCodexFile(f, includeTurns).catch(() => null)))).filter(Boolean);
  }
  if (provider === 'gemini') {
    const files = await collectFiles(dirs.geminiDir, (name, full) => name.startsWith('session-') && name.endsWith('.json') && /[/\\]chats[/\\]/.test(full));
    return (await Promise.all(files.map((f) => parseGeminiFile(f, includeTurns).catch(() => null)))).filter(Boolean);
  }
  return [];
}

export async function scanSessions({ provider = '', q = '', cwd = '', limit = 50, ...dirOverrides } = {}) {
  const dirs = defaultDirs(dirOverrides);
  const targets = provider && PROVIDERS.includes(provider) ? [provider] : PROVIDERS;
  const parsed = (await Promise.all(targets.map((p) => scanProvider(p, dirs)))).flat().map((item) => item.session);

  const query = String(q || '').trim().toLowerCase();
  const cwdFilter = String(cwd || '').trim();
  const filtered = parsed.filter((s) => {
    if (cwdFilter && s.cwd && !s.cwd.startsWith(cwdFilter)) return false;
    if (!query) return true;
    return [s.id, s.title, s.cwd, s.gitBranch, s.model, s.provider].some((v) => String(v || '').toLowerCase().includes(query));
  });

  filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  const max = Math.max(1, Math.min(200, Number(limit) || 50));
  return filtered.slice(0, max);
}

export async function readSessionTranscript(provider, sessionId, { maxTurns = 100, ...dirOverrides } = {}) {
  if (!PROVIDERS.includes(provider) || !sessionId) return null;
  const dirs = defaultDirs(dirOverrides);
  const parsed = await scanProvider(provider, dirs, { includeTurns: true });
  const match = parsed.find((item) => item.session.id === sessionId);
  if (!match) return null;
  const cap = Math.max(1, Math.min(500, Number(maxTurns) || 100));
  return {
    session: match.session,
    turns: match.turns.slice(-cap),
  };
}

export async function summarizeVault(dirOverrides = {}) {
  const dirs = defaultDirs(dirOverrides);
  const all = (await Promise.all(PROVIDERS.map((p) => scanProvider(p, dirs)))).flat().map((item) => item.session);
  const byProvider = {
    claude: { sessions: 0, inputTokens: 0, outputTokens: 0 },
    codex: { sessions: 0, inputTokens: 0, outputTokens: 0 },
    gemini: { sessions: 0, inputTokens: 0, outputTokens: 0 },
  };
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const s of all) {
    const bucket = byProvider[s.provider];
    if (!bucket) continue;
    bucket.sessions += 1;
    bucket.inputTokens += s.inputTokens || 0;
    bucket.outputTokens += s.outputTokens || 0;
    totalInputTokens += s.inputTokens || 0;
    totalOutputTokens += s.outputTokens || 0;
  }

  return {
    totalSessions: all.length,
    totalInputTokens,
    totalOutputTokens,
    byProvider,
  };
}
