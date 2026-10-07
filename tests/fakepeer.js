// Red PeerJS falsa en memoria: registra peers por id, entrega mensajes con el reloj falso
// y permite cortar la conectividad (net.kill) o caer la señalización de un peer.
function makeNet(clock) {
  const peers = new Map(), conns = new Set(); let anon = 0;
  const net = { dropping: false, blockConnect: false, silentClose: false, peers, conns };

  class FakeConn {
    constructor(peer, remoteId, metadata) { Object.assign(this, { peer, peerId: remoteId, metadata, open: false, h: {}, other: null }); conns.add(this); }
    on(e, f) { (this.h[e] = this.h[e] || []).push(f); }
    emit(e, ...a) { (this.h[e] || []).slice().forEach(f => f(...a)); }
    send(m) {
      if (!this.open || !this.other || !this.other.open || net.dropping) return;
      const msg = JSON.parse(JSON.stringify(m)), to = this.other;
      clock.setTimeout(() => { if (to.open) to.emit('data', msg); }, 1);
    }
    close() {
      if (!this.open && !(this.other && this.other.open)) { this.closed = true; return; }   // cerrada antes de abrir
      const o = this.other; this.open = false;
      if (net.silentClose) { clock.setTimeout(() => this.emit('close'), 1); return; }   // el otro extremo no se entera (zombi)
      if (o) o.open = false;
      clock.setTimeout(() => { this.emit('close'); if (o) o.emit('close'); }, 1);
    }
  }
  class FakePeer {
    constructor(id) {
      this.id = id || 'anon' + (++anon); this.h = {}; this.destroyed = false; this.disconnected = false;
      const taken = peers.get(this.id) && !peers.get(this.id).destroyed;
      if (taken) clock.setTimeout(() => this.emit('error', { type: 'unavailable-id' }), 1);
      else { peers.set(this.id, this); clock.setTimeout(() => this.emit('open', this.id), 1); }
    }
    on(e, f) { (this.h[e] = this.h[e] || []).push(f); }
    emit(e, ...a) { (this.h[e] || []).slice().forEach(f => f(...a)); }
    connect(id, opts = {}) {
      const c = new FakeConn(this, id, opts.metadata);
      clock.setTimeout(() => {
        const target = peers.get(id);
        if (net.blockConnect || this.destroyed || !target || target.destroyed || target.disconnected) { this.emit('error', { type: 'peer-unavailable' }); return; }
        const other = new FakeConn(target, this.id, opts.metadata);
        c.other = other; other.other = c;
        target.emit('connection', other);
        if (other.closed) { c.emit('close'); return; }                        // el host la rechazó
        c.open = true; other.open = true; c.emit('open'); other.emit('open');
      }, 5);
      return c;
    }
    reconnect() { this.disconnected = false; }
    destroy() { this.destroyed = true; if (peers.get(this.id) === this) peers.delete(this.id);   // un peer que no logró su id no desregistra al dueño real
      for (const c of conns) if (c.peer === this) c.close(); }
  }
  net.Peer = FakePeer;
  net.kill = () => { for (const c of [...conns]) c.close(); };                 // se cae la conectividad
  net.signalingDown = (peer) => { peer.disconnected = true; peer.emit('disconnected'); };
  return net;
}
module.exports = { makeNet };
