// Server-sent events fan-out with backpressure.
//
// Every data message is a full snapshot, so a client whose socket is backed up (a frozen or throttled
// background tab, a suspended laptop on the other end) can simply skip messages until it drains; the
// next snapshot it does get is complete. Without this, Node would buffer one snapshot per second for
// that client forever. A client that stays backed up for too long is dropped: the browser's
// EventSource reconnects on its own once the tab runs again.
export class SseHub {
  constructor({ maxBacklog = 2 * 1024 * 1024, stuckMs = 60_000 } = {}) {
    this.maxBacklog = maxBacklog;
    this.stuckMs = stuckMs;
    this.clients = new Map();   // res -> time it first had a full backlog (0 while it keeps up)
  }

  get size() { return this.clients.size; }

  add(res) {
    this.clients.set(res, 0);
    res.on('close', () => this.clients.delete(res));
  }

  // Returns true when the chunk was queued, false when it was skipped (or the client was dropped).
  write(res, chunk, now = Date.now()) {
    if (res.destroyed || res.writableEnded) { this.clients.delete(res); return false; }
    if (res.writableLength > this.maxBacklog) {
      const since = this.clients.get(res) || now;
      this.clients.set(res, since);
      if (now - since > this.stuckMs) {
        this.clients.delete(res);
        res.destroy();
      }
      return false;
    }
    if (this.clients.has(res)) this.clients.set(res, 0);
    res.write(chunk);
    return true;
  }

  broadcast(chunk, now = Date.now()) {
    for (const res of [...this.clients.keys()]) this.write(res, chunk, now);
  }
}
