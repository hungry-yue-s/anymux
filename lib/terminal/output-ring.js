// Bounded per-pane terminal output delta ring for fast reconnect replay.
// Ported from stablyai/orca (MIT).

export class OutputDeltaRing {
  constructor({ maxBytes = 256 * 1024 } = {}) {
    this.maxBytes = Math.max(1024, Number(maxBytes) || 256 * 1024);
    this.entries = [];
    this.totalBytes = 0;
    this.headSeq = 0;
  }

  push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk || ''), 'utf8');
    if (!buf.length) return this.headSeq;
    const seq = ++this.headSeq;
    this.entries.push({ seq, bytes: buf });
    this.totalBytes += buf.length;
    while (this.entries.length > 1 && this.totalBytes > this.maxBytes) {
      const removed = this.entries.shift();
      this.totalBytes -= removed.bytes.length;
    }
    if (this.totalBytes > this.maxBytes && this.entries.length === 1) {
      const single = this.entries[0];
      single.bytes = single.bytes.subarray(single.bytes.length - this.maxBytes);
      this.totalBytes = single.bytes.length;
    }
    return seq;
  }

  tailSeq() {
    return this.entries.length ? this.entries[0].seq : this.headSeq;
  }

  since(seq) {
    const requested = Number(seq);
    if (!Number.isInteger(requested) || requested < 0 || requested > this.headSeq) {
      return { ok: false, chunks: [], headSeq: this.headSeq, tailSeq: this.tailSeq() };
    }
    if (requested === this.headSeq) {
      return { ok: true, chunks: [], headSeq: this.headSeq, tailSeq: this.tailSeq() };
    }
    if (!this.entries.length) {
      return { ok: false, chunks: [], headSeq: this.headSeq, tailSeq: 0 };
    }
    const oldest = this.entries[0].seq;
    if (requested < oldest - 1) {
      return { ok: false, chunks: [], headSeq: this.headSeq, tailSeq: oldest };
    }
    return {
      ok: true,
      chunks: this.entries.filter((entry) => entry.seq > requested),
      headSeq: this.headSeq,
      tailSeq: oldest,
    };
  }
}
