/**
 * Rich tile registry for multi-pane Seam workbench panes.
 * Renders interactive browser, git diff, document preview, worktrees, sessions,
 * and automations inside tmux panes backed by @pane_kind and @pane_payload.
 */

export function parseTilePayload(payload) {
  if (!payload) return {};
  if (typeof payload === 'object' && !Array.isArray(payload)) return { ...payload };
  const text = String(payload).trim();
  if (!text) return {};
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* treat as raw scalar string */ }
  }
  if (/^https?:\/\//i.test(text)) return { url: text };
  return { path: text, raw: text };
}

export function sanitizeHttpUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch { /* invalid URL */ }
  return null;
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function btn(doc, label, onClick, className = '') {
  const node = el(doc, 'button', 'seam-tile-btn ' + className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function nodeUrl(global, serverId, path) {
  if (global?.Api?.nodeUrl) return global.Api.nodeUrl(serverId, path);
  return serverId && serverId !== 'local' ? '/n/' + encodeURIComponent(serverId) + path : path;
}

async function apiGet(global, serverId, path) {
  const url = nodeUrl(global, serverId, path);
  if (global?.Api?.get) return global.Api.get(url);
  const res = await global.fetch(url, { headers: global.Auth?.headers?.() || {} });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  return json?.data ?? json;
}

async function apiPost(global, serverId, path, body) {
  const url = nodeUrl(global, serverId, path);
  if (global?.Api?.post) return global.Api.post(url, body);
  const res = await global.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(global.Auth?.headers?.() || {}) },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  return json?.data ?? json;
}

function createBrowserTile(host, ctx) {
  const doc = ctx.global.document;
  let disposed = false;
  const wrap = el(doc, 'div', 'seam-tile seam-tile-browser');
  const bar = el(doc, 'form', 'seam-tile-bar');
  const input = el(doc, 'input', 'seam-tile-input');
  input.type = 'url';
  input.placeholder = '输入 https:// 或 http:// 地址…';
  const goBtn = el(doc, 'button', 'seam-tile-btn is-primary', '前往');
  goBtn.type = 'submit';
  const refreshBtn = btn(doc, '刷新', () => loadUrl(currentUrl, false));
  const extBtn = btn(doc, '新窗口', () => {
    const safe = sanitizeHttpUrl(input.value);
    if (safe) ctx.global.open?.(safe, '_blank', 'noopener,noreferrer');
  });
  bar.append(input, goBtn, refreshBtn, extBtn);

  const body = el(doc, 'div', 'seam-tile-body');
  wrap.append(bar, body);
  host.replaceChildren(wrap);

  let currentUrl = '';
  let iframe = null;

  function loadUrl(raw, persist = false) {
    if (disposed) return;
    const safe = sanitizeHttpUrl(raw);
    input.value = raw || '';
    if (!safe) {
      iframe = null;
      const msg = raw ? '仅支持 http:// 或 https:// 安全网页地址' : '在上方输入网页 URL 并按回车打开';
      body.replaceChildren(el(doc, 'div', 'seam-tile-empty', msg));
      return;
    }
    currentUrl = safe;
    if (!iframe || !iframe.isConnected) {
      iframe = el(doc, 'iframe', 'seam-tile-frame');
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      body.replaceChildren(iframe);
    }
    iframe.src = safe;
    if (persist) ctx.onUpdatePayload?.({ ...(ctx.payloadData || {}), url: safe });
  }

  bar.addEventListener('submit', (event) => {
    event.preventDefault();
    loadUrl(input.value, true);
  });

  loadUrl(ctx.payloadData?.url || '', false);
  return {
    update(next) {
      ctx = next;
      const nextUrl = next.payloadData?.url || '';
      if (nextUrl !== currentUrl) loadUrl(nextUrl, false);
    },
    dispose() { disposed = true; iframe = null; wrap.remove(); },
  };
}

function diffTileParams(ctx) {
  const data = ctx.payloadData || {};
  return {
    path: data.path || '.',
    ...(data.paneId ? { paneId: data.paneId } : {}),
    ...(data.commit ? { commit: data.commit } : {}),
  };
}

function createDiffTile(host, ctx) {
  const doc = ctx.global.document;
  let disposed = false;
  const mountEmbedded = ctx.global.BlockHost?.mountEmbedded;
  if (typeof mountEmbedded === 'function') {
    const embeddedHost = el(doc, 'div', 'seam-tile seam-tile-diff blk-frame blk-mode-tile');
    const embedded = mountEmbedded('git', embeddedHost, {
      serverId: ctx.serverId,
      params: diffTileParams(ctx),
      onTitle: (title) => { if (typeof ctx.onTitle === 'function') ctx.onTitle(title); },
      onSubtitle: (sub) => { if (typeof ctx.onSubtitle === 'function') ctx.onSubtitle(sub); },
      onClose: () => ctx.onClose?.(),
    });
    if (embedded) {
      host.replaceChildren(embeddedHost);
      return {
        update(next) {
          ctx = next;
          embedded.update(diffTileParams(next));
        },
        dispose() {
          disposed = true;
          embedded.dispose();
          embeddedHost.remove();
        },
      };
    }
  }
  const wrap = el(doc, 'div', 'seam-tile seam-tile-diff');
  const bar = el(doc, 'div', 'seam-tile-bar');
  const title = el(doc, 'span', 'seam-tile-title', 'Git 工作区变更');
  const openSidebarBtn = btn(doc, '在侧栏打开 Git', () => {
    ctx.global.BlockHost?.open?.('git', { path: ctx.payloadData?.path || '.' });
  });
  const refreshBtn = btn(doc, '刷新', () => load());
  bar.append(title, refreshBtn, openSidebarBtn);
  const body = el(doc, 'div', 'seam-tile-body');
  wrap.append(bar, body);
  host.replaceChildren(wrap);

  async function load() {
    if (disposed) return;
    const repoPath = ctx.payloadData?.path || '';
    title.textContent = repoPath ? 'Git · ' + repoPath : 'Git 工作区变更';
    title.title = repoPath || '';
    body.replaceChildren(el(doc, 'div', 'seam-tile-empty', '正在读取 Git 状态…'));
    try {
      const qs = repoPath ? '?path=' + encodeURIComponent(repoPath) : '';
      const status = await apiGet(ctx.global, ctx.serverId, '/api/git/status' + qs);
      if (disposed) return;
      const files = Array.isArray(status?.files) ? status.files : [];
      if (!files.length) {
        body.replaceChildren(el(doc, 'div', 'seam-tile-empty', '当前工作区干净'));
        return;
      }
      const list = el(doc, 'div', 'seam-tile-list');
      for (const file of files.slice(0, 100)) {
        const row = el(doc, 'div', 'seam-tile-row');
        const badge = el(doc, 'span', 'seam-tile-badge', file.staged ? 'S' : (file.worktree || 'M'));
        const name = el(doc, 'span', 'seam-tile-name', file.path);
        row.append(badge, name);
        list.append(row);
      }
      body.replaceChildren(list);
    } catch (err) {
      if (!disposed) body.replaceChildren(el(doc, 'div', 'seam-tile-empty', '读取 Git 状态失败: ' + err.message));
    }
  }

  load();
  return {
    update(next) { ctx = next; load(); },
    dispose() { disposed = true; wrap.remove(); },
  };
}

function createDocTile(host, ctx) {
  const doc = ctx.global.document;
  let disposed = false;
  const wrap = el(doc, 'div', 'seam-tile seam-tile-doc');
  const bar = el(doc, 'div', 'seam-tile-bar');
  const title = el(doc, 'span', 'seam-tile-title', '文档预览');
  const openBtn = btn(doc, '在侧栏打开', () => {
    const filePath = ctx.payloadData?.path;
    if (filePath) ctx.global.FilePreview?.openFile?.(filePath);
  });
  const refreshBtn = btn(doc, '刷新', () => load());
  bar.append(title, refreshBtn, openBtn);
  const body = el(doc, 'div', 'seam-tile-body');
  wrap.append(bar, body);
  host.replaceChildren(wrap);

  async function load() {
    if (disposed) return;
    const filePath = ctx.payloadData?.path || '';
    title.textContent = filePath || '文档预览';
    openBtn.disabled = !filePath;
    if (!filePath) {
      body.replaceChildren(el(doc, 'div', 'seam-tile-empty', '未指定文件路径（payload.path）'));
      return;
    }
    if (typeof ctx.global.FilePreview?.renderInto === 'function') {
      try {
        await ctx.global.FilePreview.renderInto(body, { path: filePath, name: filePath.split('/').pop(), serverId: ctx.serverId });
        return;
      } catch { /* fall back to files/read */ }
    }
    try {
      const data = await apiGet(ctx.global, ctx.serverId, '/api/files/read?path=' + encodeURIComponent(filePath));
      if (disposed) return;
      const pre = el(doc, 'pre', 'seam-tile-pre', data?.content ?? '');
      body.replaceChildren(pre);
    } catch (err) {
      if (!disposed) body.replaceChildren(el(doc, 'div', 'seam-tile-empty', '读取文件失败: ' + err.message));
    }
  }

  load();
  return {
    update(next) { ctx = next; load(); },
    dispose() { disposed = true; wrap.remove(); },
  };
}

function createWorktreesTile(host, ctx) {
  const doc = ctx.global.document;
  let disposed = false;
  const wrap = el(doc, 'div', 'seam-tile seam-tile-worktrees');
  const bar = el(doc, 'div', 'seam-tile-bar');
  bar.append(el(doc, 'span', 'seam-tile-title', 'Git Worktrees'), btn(doc, '刷新', () => load()));
  const body = el(doc, 'div', 'seam-tile-body');
  wrap.append(bar, body);
  host.replaceChildren(wrap);

  async function load() {
    if (disposed) return;
    const repo = ctx.payloadData?.path || '';
    const qs = repo ? '?path=' + encodeURIComponent(repo) : '';
    try {
      const data = await apiGet(ctx.global, ctx.serverId, '/api/worktrees' + qs);
      if (disposed) return;
      const items = Array.isArray(data?.worktrees) ? data.worktrees : [];
      if (!items.length) { body.replaceChildren(el(doc, 'div', 'seam-tile-empty', '暂无 worktree')); return; }
      const list = el(doc, 'div', 'seam-tile-list');
      for (const wt of items) {
        const row = el(doc, 'div', 'seam-tile-row');
        row.append(
          el(doc, 'span', 'seam-tile-badge', wt.branch || 'detached'),
          el(doc, 'span', 'seam-tile-name', wt.path || ''),
        );
        list.append(row);
      }
      body.replaceChildren(list);
    } catch (err) {
      if (!disposed) body.replaceChildren(el(doc, 'div', 'seam-tile-empty', '读取 worktree 失败: ' + err.message));
    }
  }

  load();
  return { update(next) { ctx = next; load(); }, dispose() { disposed = true; wrap.remove(); } };
}

function createSessionsTile(host, ctx) {
  const doc = ctx.global.document;
  let disposed = false;
  const wrap = el(doc, 'div', 'seam-tile seam-tile-sessions');
  const bar = el(doc, 'div', 'seam-tile-bar');
  bar.append(el(doc, 'span', 'seam-tile-title', 'AI 会话归档 (只读)'), btn(doc, '刷新', () => load()));
  const body = el(doc, 'div', 'seam-tile-body');
  wrap.append(bar, body);
  host.replaceChildren(wrap);

  async function load() {
    if (disposed) return;
    try {
      const data = await apiGet(ctx.global, ctx.serverId, '/api/session-vault/sessions?limit=30');
      if (disposed) return;
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      if (!sessions.length) { body.replaceChildren(el(doc, 'div', 'seam-tile-empty', '暂未扫描到历史会话')); return; }
      const list = el(doc, 'div', 'seam-tile-list');
      for (const item of sessions) {
        const row = el(doc, 'div', 'seam-tile-row');
        row.append(
          el(doc, 'span', 'seam-tile-badge', item.provider || 'ai'),
          el(doc, 'span', 'seam-tile-name', item.title || item.id || ''),
        );
        list.append(row);
      }
      body.replaceChildren(list);
    } catch (err) {
      if (!disposed) body.replaceChildren(el(doc, 'div', 'seam-tile-empty', '读取会话归档失败: ' + err.message));
    }
  }

  load();
  return { update(next) { ctx = next; load(); }, dispose() { disposed = true; wrap.remove(); } };
}

function createAutomationsTile(host, ctx) {
  const doc = ctx.global.document;
  let disposed = false;
  const wrap = el(doc, 'div', 'seam-tile seam-tile-automations');
  const bar = el(doc, 'div', 'seam-tile-bar');
  bar.append(el(doc, 'span', 'seam-tile-title', 'Cron 自动化任务'), btn(doc, '刷新', () => load()));
  const body = el(doc, 'div', 'seam-tile-body');
  wrap.append(bar, body);
  host.replaceChildren(wrap);

  async function load() {
    if (disposed) return;
    try {
      const data = await apiGet(ctx.global, ctx.serverId, '/api/automations');
      if (disposed) return;
      const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
      if (!jobs.length) { body.replaceChildren(el(doc, 'div', 'seam-tile-empty', '暂无定时任务')); return; }
      const list = el(doc, 'div', 'seam-tile-list');
      for (const job of jobs) {
        const row = el(doc, 'div', 'seam-tile-row');
        row.append(
          el(doc, 'span', 'seam-tile-badge', job.cron || ''),
          el(doc, 'span', 'seam-tile-name', job.name || job.id),
          btn(doc, '立即运行', () => apiPost(ctx.global, ctx.serverId, '/api/automations/' + encodeURIComponent(job.id) + '/run', {}).then(load).catch(() => {})),
        );
        list.append(row);
      }
      body.replaceChildren(list);
    } catch (err) {
      if (!disposed) body.replaceChildren(el(doc, 'div', 'seam-tile-empty', '读取自动化任务失败: ' + err.message));
    }
  }

  load();
  return { update(next) { ctx = next; load(); }, dispose() { disposed = true; wrap.remove(); } };
}

function createFallbackTile(host, ctx) {
  const doc = ctx.global.document;
  const wrap = el(doc, 'div', 'seam-tile seam-tile-fallback');
  const bar = el(doc, 'div', 'seam-tile-bar');
  const badge = el(doc, 'span', 'seam-tile-badge', ctx.kind || 'unknown');
  const title = el(doc, 'span', 'seam-tile-title', '未知富窗格类型');
  const actions = el(doc, 'div', 'seam-tile-actions');
  if (ctx.onConvertToTerminal) actions.append(btn(doc, '切换回终端', () => ctx.onConvertToTerminal()));
  if (ctx.onClose) actions.append(btn(doc, '关闭窗格', () => ctx.onClose()));
  bar.append(badge, title, actions);
  const pre = el(doc, 'pre', 'seam-tile-pre', typeof ctx.payload === 'string' && ctx.payload ? ctx.payload : JSON.stringify(ctx.payloadData || {}, null, 2));
  const body = el(doc, 'div', 'seam-tile-body');
  body.append(pre);
  wrap.append(bar, body);
  host.replaceChildren(wrap);
  return {
    update(next) {
      ctx = next;
      pre.textContent = typeof next.payload === 'string' && next.payload ? next.payload : JSON.stringify(next.payloadData || {}, null, 2);
    },
    dispose() { wrap.remove(); },
  };
}

export function createTileRegistry() {
  const renderers = new Map();
  const registry = {
    register(kind, spec) {
      const render = typeof spec === 'function' ? spec : spec?.render;
      if (!kind || typeof render !== 'function') throw new Error('Tile renderer requires kind and render()');
      renderers.set(kind, { kind, title: spec.title || kind, render });
    },
    get(kind) {
      return renderers.get(kind) || null;
    },
    list() {
      return [...renderers.keys()];
    },
    mount(kind, host, ctx = {}) {
      const entry = renderers.get(kind);
      const enriched = {
        global: ctx.global || globalThis,
        ...ctx,
        kind,
        payloadData: ctx.payloadData || parseTilePayload(ctx.payload),
      };
      return (entry ? entry.render : createFallbackTile)(host, enriched);
    },
  };

  registry.register('browser', { title: '网页浏览器', render: createBrowserTile });
  registry.register('diff', { title: 'Git 变更', render: createDiffTile });
  registry.register('doc', { title: '文档预览', render: createDocTile });
  registry.register('worktrees', { title: 'Worktrees', render: createWorktreesTile });
  registry.register('sessions', { title: '会话归档', render: createSessionsTile });
  registry.register('automations', { title: '自动化任务', render: createAutomationsTile });
  return registry;
}

export const TileRegistry = createTileRegistry();
