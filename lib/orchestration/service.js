// Multi-Agent Orchestration DAG runner, exclusive task leases, artifact store, and event log.
// Ported from stablyai/orca (MIT).

import { randomUUID } from 'node:crypto';
import { AppError, ErrorCode } from '../servers/errors.js';
import { openOrchestrationDb } from './schema.js';

function assertAcyclic(taskIds, edges) {
  const idSet = new Set(taskIds);
  const indeg = new Map(taskIds.map((id) => [id, 0]));
  const adj = new Map(taskIds.map((id) => [id, []]));

  for (const edge of edges) {
    if (!idSet.has(edge.from) || !idSet.has(edge.to)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `DAG edge references unknown task: ${edge.from} -> ${edge.to}`);
    }
    if (edge.from === edge.to) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `Self-loop dependency forbidden on task ${edge.from}`);
    }
    indeg.set(edge.to, (indeg.get(edge.to) || 0) + 1);
    adj.get(edge.from).push(edge.to);
  }

  const queue = [];
  for (const [id, deg] of indeg.entries()) {
    if (deg === 0) queue.push(id);
  }
  let visited = 0;
  while (queue.length) {
    const cur = queue.shift();
    visited += 1;
    for (const nxt of adj.get(cur) || []) {
      const nextDeg = indeg.get(nxt) - 1;
      indeg.set(nxt, nextDeg);
      if (nextDeg === 0) queue.push(nxt);
    }
  }
  if (visited !== taskIds.length) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Orchestration DAG contains a cycle');
  }
}

export class OrchestrationService {
  constructor({ dbPath = ':memory:', now = Date.now } = {}) {
    this.store = openOrchestrationDb(dbPath);
    this.db = this.store.db;
    this.now = now;
  }

  close() {
    this.store.close();
  }

  _logEvent(runId, taskId, kind, payload = {}) {
    this.db.prepare(`
      INSERT INTO events (run_id, task_id, kind, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, taskId || '', kind, JSON.stringify(payload), this.now());
  }

  createRun({ title, rootCwd = '', tasks = [], edges = [], meta = {} } = {}) {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Orchestration run title is required');
    if (!Array.isArray(tasks) || !tasks.length) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'At least one task is required');
    }

    const now = this.now();
    const runId = `run_${randomUUID().slice(0, 8)}`;
    const normalizedTasks = tasks.map((t, idx) => {
      const id = String(t.id || `t${idx + 1}`).trim();
      if (!id) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Task id is required');
      return {
        id,
        title: String(t.title || id).trim(),
        agentType: String(t.agentType || 'codex').trim(),
        prompt: String(t.prompt || ''),
        worktreePath: String(t.worktreePath || ''),
        paneId: String(t.paneId || ''),
      };
    });
    const normalizedEdges = (Array.isArray(edges) ? edges : []).map((e) => ({
      from: String(e.from || e.fromTaskId || '').trim(),
      to: String(e.to || e.toTaskId || '').trim(),
    }));

    assertAcyclic(normalizedTasks.map((t) => t.id), normalizedEdges);

    // Namespace task IDs internally with runId if needed? Keep global unique ID per DB by prefixing unless already run-scoped, or store composite?
    // Schema uses `tasks.id TEXT PRIMARY KEY`: namespace cleanly when collision possible by allowing explicit IDs or run-scoped lookup.
    // Wait: let's store unique key `${runId}:${localId}` OR keep caller's unique id if unique across DB; simplest & safest is unique ID `${runId}:${localId}`?
    // Wait: API callers might pass `task.id` returned by `createRun`. Returning normalized `tasks` with exact stored `id` guarantees clarity!
    const keyFor = (localId) => `${runId}:${localId}`;

    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        INSERT INTO runs (id, title, status, root_cwd, created_at, updated_at, meta_json)
        VALUES (?, ?, 'running', ?, ?, ?, ?)
      `).run(runId, cleanTitle, rootCwd, now, now, JSON.stringify(meta || {}));

      const insertTask = this.db.prepare(`
        INSERT INTO tasks (id, run_id, title, agent_type, prompt, status, pane_id, worktree_path, output_summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, '', ?, ?)
      `);
      for (const t of normalizedTasks) {
        insertTask.run(keyFor(t.id), runId, t.title, t.agentType, t.prompt, t.paneId, t.worktreePath, now, now);
      }

      const insertEdge = this.db.prepare(`
        INSERT INTO task_edges (run_id, from_task_id, to_task_id) VALUES (?, ?, ?)
      `);
      for (const e of normalizedEdges) {
        insertEdge.run(runId, keyFor(e.from), keyFor(e.to));
      }

      this._logEvent(runId, '', 'run_created', { taskCount: normalizedTasks.length, edgeCount: normalizedEdges.length });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.getRun(runId);
  }

  listRuns(limit = 50) {
    return this.db.prepare('SELECT * FROM runs ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, Math.min(200, Number(limit) || 50)));
  }

  getRun(runId) {
    const run = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, `Orchestration run ${runId} not found`);
    const tasks = this.db.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY rowid ASC').all(runId);
    const edges = this.db.prepare('SELECT * FROM task_edges WHERE run_id = ?').all(runId);
    const leases = this.db.prepare(`
      SELECT l.* FROM leases l
      JOIN tasks t ON t.id = l.task_id
      WHERE t.run_id = ?
    `).all(runId);
    const artifacts = this.db.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at DESC').all(runId);
    const events = this.db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 100').all(runId);
    return { run, tasks, edges, leases, artifacts, events };
  }

  readyTasks(runId) {
    const now = this.now();
    this.getRun(runId);
    return this.db.prepare(`
      SELECT t.* FROM tasks t
      WHERE t.run_id = ?
        AND t.status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM task_edges e
          JOIN tasks upstream ON upstream.id = e.from_task_id
          WHERE e.to_task_id = t.id AND upstream.status != 'done'
        )
        AND NOT EXISTS (
          SELECT 1 FROM leases l
          WHERE l.task_id = t.id AND l.expires_at > ?
        )
      ORDER BY t.rowid ASC
    `).all(runId, now);
  }

  acquireLease(taskId, { holderId, ttlMs = 60_000 } = {}) {
    const holder = String(holderId || '').trim();
    if (!holder) throw new AppError(ErrorCode.VALIDATION_ERROR, 'holderId is required');
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) throw new AppError(ErrorCode.NOT_FOUND, `Task ${taskId} not found`);
    if (task.status === 'done' || task.status === 'failed') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `Task ${taskId} already finished (${task.status})`);
    }
    const blocking = this.db.prepare(`
      SELECT upstream.id FROM task_edges e
      JOIN tasks upstream ON upstream.id = e.from_task_id
      WHERE e.to_task_id = ? AND upstream.status != 'done'
      LIMIT 1
    `).get(taskId);
    if (blocking) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `Task ${taskId} blocked by unfinished dependency ${blocking.id}`);
    }

    const now = this.now();
    const expiresAt = now + Math.max(1000, Number(ttlMs) || 60_000);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM leases WHERE task_id = ?').get(taskId);
      if (existing && existing.expires_at > now && existing.holder_id !== holder) {
        const err = new AppError(ErrorCode.VALIDATION_ERROR, `Task ${taskId} is actively leased by ${existing.holder_id}`);
        err.status = 409;
        throw err;
      }
      this.db.prepare(`
        INSERT INTO leases (task_id, holder_id, acquired_at, expires_at, heartbeat_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          holder_id=excluded.holder_id,
          acquired_at=excluded.acquired_at,
          expires_at=excluded.expires_at,
          heartbeat_at=excluded.heartbeat_at
      `).run(taskId, holder, existing?.holder_id === holder ? existing.acquired_at : now, expiresAt, now);

      this.db.prepare(`UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`).run(now, taskId);
      this._logEvent(task.run_id, taskId, 'lease_acquired', { holderId: holder, expiresAt });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.db.prepare('SELECT * FROM leases WHERE task_id = ?').get(taskId);
  }

  heartbeatLease(taskId, holderId, ttlMs = 60_000) {
    const existing = this.db.prepare('SELECT * FROM leases WHERE task_id = ?').get(taskId);
    if (!existing || existing.holder_id !== holderId) {
      const err = new AppError(ErrorCode.VALIDATION_ERROR, 'Lease not held by caller');
      err.status = 409;
      throw err;
    }
    const now = this.now();
    const expiresAt = now + Math.max(1000, Number(ttlMs) || 60_000);
    this.db.prepare('UPDATE leases SET heartbeat_at = ?, expires_at = ? WHERE task_id = ?').run(now, expiresAt, taskId);
    return this.db.prepare('SELECT * FROM leases WHERE task_id = ?').get(taskId);
  }

  completeTask(taskId, { holderId = null, status = 'done', outputSummary = '', artifacts = [] } = {}) {
    if (status !== 'done' && status !== 'failed') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Task completion status must be done or failed');
    }
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) throw new AppError(ErrorCode.NOT_FOUND, `Task ${taskId} not found`);

    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lease = this.db.prepare('SELECT * FROM leases WHERE task_id = ?').get(taskId);
      if (lease && holderId && lease.holder_id !== holderId && lease.expires_at > now) {
        const err = new AppError(ErrorCode.VALIDATION_ERROR, 'Lease held by another worker');
        err.status = 409;
        throw err;
      }
      this.db.prepare('DELETE FROM leases WHERE task_id = ?').run(taskId);
      this.db.prepare('UPDATE tasks SET status = ?, output_summary = ?, updated_at = ? WHERE id = ?')
        .run(status, String(outputSummary || ''), now, taskId);

      const insertArtifact = this.db.prepare(`
        INSERT INTO artifacts (id, run_id, task_id, kind, path, summary, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const art of Array.isArray(artifacts) ? artifacts : []) {
        insertArtifact.run(
          `art_${randomUUID().slice(0, 8)}`,
          task.run_id,
          taskId,
          String(art.kind || 'file'),
          String(art.path || ''),
          String(art.summary || ''),
          now,
        );
      }

      this._logEvent(task.run_id, taskId, 'task_completed', { status, outputSummary: String(outputSummary || '').slice(0, 200) });

      const siblings = this.db.prepare('SELECT status FROM tasks WHERE run_id = ?').all(task.run_id);
      let nextRunStatus = 'running';
      if (siblings.every((s) => s.status === 'done')) nextRunStatus = 'completed';
      else if (siblings.some((s) => s.status === 'failed')) nextRunStatus = 'failed';
      this.db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE id = ?').run(nextRunStatus, now, task.run_id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.getRun(task.run_id);
  }
}
