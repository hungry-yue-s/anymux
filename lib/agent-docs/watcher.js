// Finds documents agents write without asking the agent to do anything: for
// the projects the panes are in, it looks at the document directories of
// lib/agent-docs/profiles.js and announces each new file once. Works the same
// for Claude, Codex, Qoder, DeepSeek Harness or anything else that writes a
// file, including skills (superpowers) that never heard of the panel.
//
// The first look at a project only records what is already there; documents
// that existed before are never opened. A changed document is not announced
// again: a tab that shows it refreshes itself, and one the person closed stays
// closed.

import { promises as fs } from 'node:fs';
import { classifyDoc, WATCH_DIRS } from './profiles.js';
import { findProjectRoot, pathSpace, withinRoots } from './project.js';

const PANE_REFRESH_MS = 10_000;
const ROOT_CACHE_MS = 60_000;
const MAX_PROJECTS = 32;
const MAX_FILES_PER_DIR = 200;
const MAX_PANES_PER_EVENT = 32;

export class DocWatcher {
  /**
   * @param {object} options
   * @param {() => Promise<{paneId: string, windowId: string, path: string}[]>} options.listPanes
   * @param {string[]} options.roots the preview roots; projects outside them are not watched
   * @param {(event: object) => void} options.emit
   */
  constructor({ listPanes, roots, emit, space = pathSpace, now = Date.now,
    paneRefreshMs = PANE_REFRESH_MS, maxProjects = MAX_PROJECTS }) {
    this.listPanes = listPanes;
    this.roots = roots;
    this.emit = emit;
    this.space = space;
    this.now = now;
    this.paneRefreshMs = paneRefreshMs;
    this.maxProjects = maxProjects;
    this.projects = new Map();
    this.rootByCwd = new Map();
    this.panesAt = -Infinity;
    this.running = null;
    this.disposed = false;
  }

  /** One round: re-reads the panes now and then, looks at every project's document directories. */
  tick() {
    if (this.disposed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this._tick().finally(() => { this.running = null; });
    return this.running;
  }

  dispose() {
    this.disposed = true;
    this.projects.clear();
    this.rootByCwd.clear();
  }

  async _tick() {
    if (this.now() - this.panesAt >= this.paneRefreshMs) await this._refreshPanes();
    for (const project of this.projects.values()) {
      if (this.disposed) return;
      const found = await this._scan(project.root);
      if (project.seen) {
        for (const path of found) {
          if (!project.seen.has(path)) this._announce(project, path);
        }
      }
      project.seen = found;
    }
  }

  async _projectRoot(cwd) {
    const cached = this.rootByCwd.get(cwd);
    if (cached && this.now() - cached.at < ROOT_CACHE_MS) return cached.root;
    const project = await findProjectRoot(cwd, this.space).catch(() => null);
    const root = project && withinRoots(project.root, this.roots, this.space) ? project.root : null;
    this.rootByCwd.set(cwd, { root, at: this.now() });
    return root;
  }

  async _refreshPanes() {
    this.panesAt = this.now();
    let panes;
    try { panes = await this.listPanes(); } catch { panes = []; }
    const next = new Map();
    for (const pane of panes) {
      if (!pane || typeof pane.path !== 'string' || !pane.path.startsWith('/')) continue;
      const root = await this._projectRoot(pane.path);
      if (!root) continue;
      const key = this.space.key(root);
      let project = next.get(key);
      if (!project) {
        if (next.size >= this.maxProjects) continue;
        const previous = this.projects.get(key);
        project = { root, paneIds: [], seen: previous ? previous.seen : null };
        next.set(key, project);
      }
      if (!project.paneIds.includes(pane.paneId)) project.paneIds.push(pane.paneId);
    }
    this.projects = next;
    // Directories no pane is in any more do not need their roots remembered.
    const live = new Set(panes.map((pane) => pane && pane.path));
    for (const cwd of this.rootByCwd.keys()) if (!live.has(cwd)) this.rootByCwd.delete(cwd);
  }

  async _list(dir) {
    try {
      return (await fs.readdir(this.space.toFs(dir), { withFileTypes: true })).slice(0, MAX_FILES_PER_DIR);
    } catch {
      return [];
    }
  }

  async _scan(root) {
    const found = new Set();
    for (const watch of WATCH_DIRS) {
      const base = (root === '/' ? '' : root) + '/' + watch.dir;
      for (const entry of await this._list(base)) {
        if (watch.depth === 1) {
          const path = base + '/' + entry.name;
          if ((entry.isFile() || entry.isSymbolicLink()) && classifyDoc(path)) found.add(path);
          continue;
        }
        if (!entry.isDirectory()) continue;
        const path = base + '/' + entry.name + '/' + watch.file;
        if (!classifyDoc(path)) continue;
        try {
          if ((await fs.stat(this.space.toFs(path))).isFile()) found.add(path);
        } catch { /* not written yet */ }
      }
    }
    return found;
  }

  _announce(project, path) {
    const profile = classifyDoc(path);
    if (!profile) return;
    this.emit({
      type: 'open-file',
      path,
      paneId: project.paneIds[0] || null,
      paneIds: project.paneIds.slice(0, MAX_PANES_PER_EVENT),
      placement: 'dock',
      activate: profile.open !== 'background',
      origin: 'agent-doc',
      kind: profile.kind,
      owner: profile.owner,
    });
  }
}
