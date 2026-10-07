// Simula dos "máquinas" (host y guest) con dos copias independientes del juego,
// conectadas por una cola de mensajes en memoria (JSON, como WebRTC) y un reloj falso compartido.
const { loadGame } = require('./load');

const NAMES = ['simulate','UNITS','G','makeRNG','onData','send','startMatch','tryResolve','newRound','finishRound','playback','confirmReady','sanitizeDeploy','sanitizeTech','onFoeReady','connectionLost','leaveToLobby','onIncoming','onFieldTap','undoLast'];

function makeClock() {
  let now = 0, id = 1; const tm = new Map();
  const add = (fn, ms, rep) => { const i = id++; tm.set(i, { fn, at: now + ms, ms, rep }); return i; };
  return {
    setTimeout: (f, ms) => add(f, ms, false), setInterval: (f, ms) => add(f, ms, true),
    clearTimeout: i => tm.delete(i), clearInterval: i => tm.delete(i),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [i, t] of tm) if (t.at <= end && (!next || t.at < next.t.at || (t.at === next.t.at && i < next.i))) next = { i, t };
        if (!next) break;
        now = next.t.at;
        if (next.t.rep) next.t.at += next.t.ms; else tm.delete(next.i);
        next.t.fn();
      }
      now = end;
    },
    get now() { return now; },
  };
}

function makePair() {
  const clock = makeClock();
  const sb = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval };
  const hl = loadGame(NAMES, { ...sb }), gl = loadGame(NAMES, { ...sb });
  const host = hl.api, guest = gl.api;
  const queue = [];
  const log = { host: [], guest: [], lost: { host: 0, guest: 0 } };                 // cada simulate() que corre cada máquina
  for (const [who, l] of [['host', hl], ['guest', gl]]) {
    const real = l.ctx.simulate;
    l.ctx.simulate = (...a) => { const r = real(...a); log[who].push({ winner: r.winner, hostHP: r.hostHP, guestHP: r.guestHP }); return r; };
  }
  log.views = { host: [], guest: [] };                  // cada frame dibujado en combate (simView)
  for (const [who, l] of [['host', hl], ['guest', gl]]) {
    const real = l.ctx.drawField;
    l.ctx.drawField = (sim, ...r) => { if (sim) log.views[who].push(sim); return real(sim, ...r); };
  }
  for (const [who, l] of [['host', hl], ['guest', gl]]) {
    const real = l.ctx.connectionLost;
    l.ctx.connectionLost = (...a) => { log.lost[who]++; return real(...a); };
  }
  host.G.isHost = true;  host.G.name = 'H'; host.G.conn = { open: true, send: m => queue.push({ to: guest, m: JSON.parse(JSON.stringify(m)) }) };
  guest.G.isHost = false; guest.G.name = 'G'; guest.G.conn = { open: true, send: m => queue.push({ to: host, m: JSON.parse(JSON.stringify(m)) }) };
  function pump() { while (queue.length) { const { to, m } = queue.shift(); to.onData(m); } }
  return { host, guest, queue, pump, clock, log, hl, gl };
}

// Hace el handshake real: cada lado manda 'hello' al abrir la conexión.
function handshake(p) {
  p.host.send({ t: 'hello', name: p.host.G.name });
  p.guest.send({ t: 'hello', name: p.guest.G.name });
  p.pump();
}

// Dos máquinas que usan hostCreate()/joinRoom() reales sobre la red PeerJS falsa.
const NET_NAMES = NAMES.concat(['hostCreate','joinRoom','beginReconnect','giveUpReconnect']);
function makeNetPair() {
  const { makeNet } = require('./fakepeer');
  const clock = makeClock(); const net = makeNet(clock);
  const sb = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval, Peer: net.Peer, navigator: {} };
  const hl = loadGame(NET_NAMES, { ...sb }), gl = loadGame(NET_NAMES, { ...sb });
  const el = (l, id) => l.ctx.document.getElementById(id);
  const log = { host: [], guest: [] };
  for (const [who, l] of [['host', hl], ['guest', gl]]) {
    const real = l.ctx.simulate;
    l.ctx.simulate = (...a) => { const r = real(...a); log[who].push({ winner: r.winner, hostHP: r.hostHP, guestHP: r.guestHP }); return r; };
  }
  el(hl, 'playerName').value = 'H'; hl.api.hostCreate(); clock.advance(10);
  const code = el(hl, 'roomCode').textContent;
  el(gl, 'playerName').value = 'G'; el(gl, 'joinCode').value = code; gl.api.joinRoom(); clock.advance(100);
  return { host: hl.api, guest: gl.api, hl, gl, clock, net, log, code, el };
}
module.exports = { makePair, handshake, makeNetPair };
