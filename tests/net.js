// Simula dos "máquinas" (host y guest) con dos copias independientes del juego,
// conectadas por una cola de mensajes en memoria (JSON, como WebRTC).
const { loadGame } = require('./load');

const NAMES = ['simulate','UNITS','G','makeRNG','onData','send','startMatch','tryResolve','newRound','finishRound','playback'];

function makePair() {
  const host = loadGame(NAMES).api, guest = loadGame(NAMES).api;
  const queue = [];
  host.G.isHost = true;  host.G.name = 'H'; host.G.conn = { open: true, send: m => queue.push({ to: guest, m: JSON.parse(JSON.stringify(m)) }) };
  guest.G.isHost = false; guest.G.name = 'G'; guest.G.conn = { open: true, send: m => queue.push({ to: host, m: JSON.parse(JSON.stringify(m)) }) };
  function pump() { while (queue.length) { const { to, m } = queue.shift(); to.onData(m); } }
  return { host, guest, queue, pump };
}

// Hace el handshake real: cada lado manda 'hello' al abrir la conexión.
function handshake(p) {
  p.host.send({ t: 'hello', name: p.host.G.name });
  p.guest.send({ t: 'hello', name: p.guest.G.name });
  p.pump();
}

module.exports = { makePair, handshake };
