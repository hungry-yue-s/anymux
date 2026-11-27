import { afterEach, describe, expect, it } from 'vitest';
import { ORCHESTRATION_TABLES } from '../../lib/orchestration/schema.js';
import { OrchestrationService } from '../../lib/orchestration/service.js';

const svcs = [];
afterEach(() => {
  for (const s of svcs.splice(0)) s.close();
});

describe('Multi-Agent Orchestration SQLite DAG (Orca MIT port)', () => {
  it('initializes all 6 schema tables and rejects cyclic DAG graphs', () => {
    const svc = new OrchestrationService({ dbPath: ':memory:' });
    svcs.push(svc);

    const tables = svc.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    for (const table of ORCHESTRATION_TABLES) {
      expect(tables).toContain(table);
    }

    expect(() => svc.createRun({
      title: 'Cyclic run',
      tasks: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    })).toThrow(/cycle/i);
  });

  it('tracks readiness across DAG edges, enforces exclusive leases with expiry, and logs artifacts', () => {
    let clock = 10_000;
    const svc = new OrchestrationService({ dbPath: ':memory:', now: () => clock });
    svcs.push(svc);

    const created = svc.createRun({
      title: 'Parallel build & review',
      rootCwd: '/srv/repo',
      tasks: [
        { id: 'plan', title: 'Plan', agentType: 'claude', prompt: 'Write design' },
        { id: 'impl', title: 'Implement', agentType: 'codex', prompt: 'Write code' },
        { id: 'review', title: 'Review', agentType: 'gemini', prompt: 'Review PR' },
      ],
      edges: [
        { from: 'plan', to: 'impl' },
        { from: 'impl', to: 'review' },
      ],
    });

    const planId = `${created.run.id}:plan`;
    const implId = `${created.run.id}:impl`;

    // Only plan is ready initially
    expect(svc.readyTasks(created.run.id).map((t) => t.id)).toEqual([planId]);

    // Blocked downstream task cannot acquire lease
    expect(() => svc.acquireLease(implId, { holderId: 'worker-2' })).toThrow(/blocked/i);

    // Worker 1 claims plan lease; Worker 2 conflicts with 409 until TTL expires
    svc.acquireLease(planId, { holderId: 'worker-1', ttlMs: 5000 });
    expect(() => svc.acquireLease(planId, { holderId: 'worker-2', ttlMs: 5000 })).toThrow(/leased by worker-1/i);

    // Heartbeat extends expiry cleanly
    clock += 4000;
    svc.heartbeatLease(planId, 'worker-1', 5000);
    expect(() => svc.acquireLease(planId, { holderId: 'worker-2', ttlMs: 5000 })).toThrow(/leased by worker-1/i);

    // Complete plan -> impl unlocks!
    svc.completeTask(planId, {
      holderId: 'worker-1',
      status: 'done',
      outputSummary: 'Design complete',
      artifacts: [{ kind: 'spec', path: 'docs/spec.md', summary: 'Design doc' }],
    });
    expect(svc.readyTasks(created.run.id).map((t) => t.id)).toEqual([implId]);

    // If impl lease expires untouched, another worker can take over
    svc.acquireLease(implId, { holderId: 'worker-2', ttlMs: 2000 });
    clock += 3000;
    const reclaimed = svc.acquireLease(implId, { holderId: 'worker-3', ttlMs: 5000 });
    expect(reclaimed.holder_id).toBe('worker-3');

    // Finish remaining tasks -> run status becomes completed
    svc.completeTask(implId, { holderId: 'worker-3', status: 'done', outputSummary: 'Implemented' });
    const reviewId = `${created.run.id}:review`;
    svc.acquireLease(reviewId, { holderId: 'worker-4' });
    const finalState = svc.completeTask(reviewId, { holderId: 'worker-4', status: 'done', outputSummary: 'LGTM' });

    expect(finalState.run.status).toBe('completed');
    expect(finalState.artifacts).toHaveLength(1);
    expect(finalState.events.length).toBeGreaterThanOrEqual(7);
  });
});
