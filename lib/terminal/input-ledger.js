// Per-(clientId, paneId) idempotent input ACK ledger preventing duplicate keystrokes on retry.
// Ported from stablyai/orca (MIT).

export class InputAckLedger {
  constructor({ maxPerClient = 512 } = {}) {
    this.maxPerClient = Math.max(32, Number(maxPerClient) || 512);
    this.clients = new Map();
  }

  _bucket(clientId) {
    let panes = this.clients.get(clientId);
    if (!panes) {
      panes = new Map();
      this.clients.set(clientId, panes);
    }
    return panes;
  }

  checkAndRecord(clientId, paneId, seq) {
    const cleanClient = typeof clientId === 'string' && clientId.trim() ? clientId.trim() : null;
    const cleanPane = typeof paneId === 'string' && paneId.trim() ? paneId.trim() : null;
    if (!cleanClient || !cleanPane || !Number.isInteger(seq) || seq < 0) {
      return { duplicate: false, ackSeq: seq ?? null };
    }
    const panes = this._bucket(cleanClient);
    let entry = panes.get(cleanPane);
    if (!entry) {
      entry = { lastSeq: -1, seen: new Set(), order: [] };
      panes.set(cleanPane, entry);
    }
    if (entry.seen.has(seq) || seq <= entry.lastSeq - this.maxPerClient) {
      return { duplicate: true, ackSeq: entry.lastSeq };
    }
    entry.seen.add(seq);
    entry.order.push(seq);
    if (seq > entry.lastSeq) entry.lastSeq = seq;
    while (entry.order.length > this.maxPerClient) {
      const old = entry.order.shift();
      entry.seen.delete(old);
    }
    return { duplicate: false, ackSeq: seq };
  }

  lastSeq(clientId, paneId) {
    return this.clients.get(clientId)?.get(paneId)?.lastSeq ?? null;
  }

  clearClient(clientId) {
    this.clients.delete(clientId);
  }
}
