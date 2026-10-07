// Simula dos "máquinas" (host y guest) con dos copias independientes del juego,
// conectadas por una cola de mensajes en memoria (JSON, como WebRTC) y un reloj falso compartido.
const { loadGame } = require('./load');

const NAMES = ['simulate','UNITS','G','makeRNG','onData','send','startMatch','tryResolve','newRound','finishRound','playback','confirmReady','sanitizeDeploy','sanitizeTech','onFoeReady','connectionLost','leaveToLobby','onIncoming','onFieldTap','undoLast','P','FXQ','setFx','drawBattle','HAS_RAF','spriteFor','spriteDir','AUD','sfx','audioInit','setSnd','buildSummary','renderSummary','expand','startPlanTimer','tickPlanTimer','requestRematch','Rec','replaysLoad','replaySave','sanitizeReplay','replayEncode','replayDecode','replayOpen','replayClose','replayToggle','replaySeek','replayLoadRound','RP','SIM_VERSION','NET_VERSION','replayLink','replayImport','REPLAY_MAX','PERSIST_DAMAGE','matchOutcome','UNITS','unlockOffer','pickUnlock','STARTERS','OFFER_SIZE'];

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

function makePair(opts = {}) {
  const clock = makeClock();
  const sb = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval };
  let audio = null;
  if (opts.audio) { audio = require('./fakeaudio').makeFakeAudio(clock); sb.AudioContext = audio.FakeAC; }
  const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { if (opts.storageThrows) throw new Error('cuota'); m.set(k, v); }, removeItem: k => m.delete(k), m }; };
  const stores = { host: store(), guest: store() };
  if (opts.raf) { sb.requestAnimationFrame = cb => clock.setTimeout(() => cb(clock.now), 16); sb.performance = { now: () => clock.now }; }   // ~60fps
  const hl = loadGame(NAMES, { ...sb, localStorage: stores.host }), gl = loadGame(NAMES, { ...sb, localStorage: stores.guest });
  const host = hl.api, guest = gl.api;
  const queue = [];
  const log = { host: [], guest: [], lost: { host: 0, guest: 0 }, battleDraws: { host: 0, guest: 0 } };                 // cada simulate() que corre cada máquina
  for (const [who, l] of [['host', hl], ['guest', gl]]) {
    const real = l.ctx.simulate;
    l.ctx.simulate = (...a) => { const r = real(...a); log[who].push({ winner: r.winner, hostHP: r.hostHP, guestHP: r.guestHP }); return r; };
  }
  for (const [who, l] of [['host', hl], ['guest', gl]]) {
    const real = l.ctx.drawBattle;
    if (real) l.ctx.drawBattle = (...a) => { log.battleDraws[who]++; return real(...a); };
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
  return { host, guest, queue, pump, clock, log, hl, gl, audio, stores };
}

// Hace el handshake real: cada lado manda 'hello' al abrir la conexión.
// Los tests despliegan cualquier unidad: salvo que se pida lo contrario (keepLocks) se desbloquea todo en ambas máquinas.
function unlockAll(m) { const all = Object.keys(m.UNITS); m.G.unlocked = new Set(all); m.G.foeUnlocked = new Set(all); }
function handshake(p, o = {}) {
  const v = { sim: p.host.SIM_VERSION, net: p.host.NET_VERSION };       // como wireConn: el hello lleva las versiones
  p.host.send({ t: 'hello', name: p.host.G.name, ...v });
  p.guest.send({ t: 'hello', name: p.guest.G.name, ...v });
  p.pump();
  if (!o.keepLocks) { unlockAll(p.host); unlockAll(p.guest); }
}

// Dos máquinas que usan hostCreate()/joinRoom() reales sobre la red PeerJS falsa.
const NET_NAMES = NAMES.concat(['hostCreate','joinRoom','beginReconnect','giveUpReconnect','mmStart','MM','NET_VERSION']);
function makeNetPair(opts = {}) {
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
  if (!opts.keepLocks) { unlockAll(hl.api); unlockAll(gl.api); }
  return { host: hl.api, guest: gl.api, hl, gl, clock, net, log, code, el };
}
// N máquinas independientes sobre la MISMA red PeerJS falsa y el mismo reloj (para matchmaking).
const MM_NAMES = NAMES.concat(['mmStart','mmStop','mmCancel','mmRestart','MM','startMatch','hostCreate','joinRoom','NET_VERSION','startBotMatch','botNew','botTurn','confirmReady','requestRematch','leaveToLobby','matchOutcome']);
function makeCrowd(n, opts = {}) {
  const { makeNet } = require('./fakepeer');
  const clock = makeClock(); const net = makeNet(clock);
  const sb = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval, Peer: net.Peer, navigator: {}, performance: { now: () => clock.now } };
  const ms = [];
  const add = (name) => {
    const l = loadGame(MM_NAMES, { ...sb });
    l.ctx.document.getElementById('playerName').value = name;
    const m = { name, api: l.api, ctx: l.ctx, G: l.api.G, MM: l.api.MM };
    ms.push(m); return m;
  };
  for (let i = 0; i < n; i++) add('P' + i);
  return { ms, clock, net, add, run: (ms_) => clock.advance(ms_) };
}
module.exports = { makePair, handshake, makeNetPair, makeCrowd, unlockAll };
