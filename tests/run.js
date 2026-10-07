// Tests de MemeBellum. Uso: node tests/run.js [--report]
const fs = require('fs');
const vm = require('vm');
const { loadGame, extractScript, HTML_PATH } = require('./load');

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}

// (a) sintaxis
const src = extractScript(fs.readFileSync(HTML_PATH, 'utf8'));
try { new vm.Script(src, { filename: 'index.html<script>' }); check('sintaxis válida', true); }
catch (e) { check('sintaxis válida', false, e.message); process.exit(1); }

const { api } = loadGame();
const { simulate, UNITS, makeRNG } = api;

// ---- generador de ejércitos de prueba (RNG propio del test, no de la sim) ----
function buildArmy(rng, ids, budget, W = 1000, H = 440) {
  const deploy = [];
  let spent = 0, i = 0;
  while (true) {
    const u = UNITS[ids[i++ % ids.length]];
    if (spent + u.cost > budget) break;
    spent += u.cost;
    deploy.push({ id: u.id, lvl: 1, x: 60 + rng() * (W - 120), y: H * 0.56 + rng() * (H * 0.4) });
  }
  return deploy;
}
const idsOfType = t => Object.values(UNITS).filter(u => u.type === t).map(u => u.id);

function duelWinrate(typeA, typeB, n = 40, budget = 800) {
  const rng = makeRNG(12345);
  let wins = 0, draws = 0;
  for (let k = 0; k < n; k++) {
    const A = buildArmy(rng, idsOfType(typeA), budget);
    const B = buildArmy(rng, idsOfType(typeB), budget);
    // alternamos lados para no sesgar por posición
    const aIsHost = k % 2 === 0;
    const r = aIsHost
      ? simulate(A, B, {}, {}, 1000 + k)
      : simulate(B, A, {}, {}, 1000 + k);
    const aSide = aIsHost ? 'host' : 'guest';
    if (r.winner === 'draw') draws++; else if (r.winner === aSide) wins++;
  }
  return { wins, draws, n, rate: (wins + draws / 2) / n };
}

// (b) triángulo de contras: el que "gana" debe ganar claramente a costo igual.
// A 300◈ todavía es una sola unidad contra un enjambre (no hay masa crítica), por eso se exige desde 500◈.
const TRI = [['swarm', 'heavy'], ['heavy', 'ranged'], ['ranged', 'swarm']];
const TRI_BUDGETS = [500, 1200, 2500];
for (const budget of TRI_BUDGETS) for (const [a, b] of TRI) {
  const r = duelWinrate(a, b, 40, budget);
  check(`triángulo @${budget}◈: ${a} > ${b}`, r.rate >= 0.6, `${(r.rate * 100).toFixed(0)}% (${r.wins}/${r.n}, empates ${r.draws})`);
}

// (b2) ninguna unidad es inútil ni dominante: winrate promedio contra las demás (ejércitos puros, 1000◈)
{
  const { createBench } = require('./balance');
  const B = createBench(); const ids = B.ids(); const bad = [], info = [];
  for (const a of ids) {
    const v = ids.filter(c => c !== a).map(c => B.unitDuel(a, c, 1000, 30, 321));
    const avg = v.reduce((s, x) => s + x, 0) / v.length;
    info.push(`${a} ${(avg * 100).toFixed(0)}%`);
    if (avg < 0.25 || avg > 0.75) bad.push(`${a} ${(avg * 100).toFixed(0)}%`);
  }
  check('balance: ninguna unidad fuera de 25–75% de winrate promedio', bad.length === 0, bad.length ? 'fuera de rango: ' + bad.join(', ') : info.join(', '));
  // (b3) fusión: una unidad nivel 2 no debe aplastar a dos de nivel 1 (mismo costo)
  const worst = ids.map(id => [id, B.fusionDuel(id, 30, 321).L2]).sort((x, y) => y[1] - x[1])[0];
  check('balance: fusión L2 vs 2×L1 no domina (≤ 92%)', worst[1] <= 0.92, `peor caso ${worst[0]} ${(worst[1] * 100).toFixed(0)}%`);
}

// (c) determinismo: misma entrada -> mismo resultado exacto
{
  const rng = makeRNG(777);
  let same = true;
  for (let k = 0; k < 10 && same; k++) {
    const H = buildArmy(rng, Object.keys(UNITS), 1200), Gd = buildArmy(rng, Object.keys(UNITS), 1200);
    const tech = { warden: true, longbow: true };
    const r1 = simulate(H, Gd, tech, {}, 4242 + k), r2 = simulate(H, Gd, tech, {}, 4242 + k);
    same = JSON.stringify(r1) === JSON.stringify(r2);
  }
  check('determinismo: misma entrada, mismo resultado', same);
}

// (d) handshake: host y guest deben terminar con la MISMA semilla (regresión del bug de semilla asimétrica)
{
  const { makePair, handshake } = require('./net');
  let ok = true, bad = 0;
  for (let i = 0; i < 200; i++) {
    const p = makePair(); handshake(p);
    if (p.host.G.seed !== p.guest.G.seed || !p.host.G.seed) { ok = false; bad++; }
  }
  check('handshake: host y guest comparten la misma semilla', ok, ok ? '200 handshakes' : `${bad}/200 con semillas distintas`);
}

// (e) sincronía de rondas con velocidades de reproducción distintas (host 4x, guest 0.5x)
{
  const { makePair, handshake } = require('./net');
  const p = makePair(); handshake(p);
  p.host.G.battleSpeed = 4; p.guest.G.battleSpeed = 0.5;
  const addUnits = (m, y) => m.G.myDeploy.push({ id: 'warden', lvl: 1, x: 300, y }, { id: 'marauder', lvl: 1, x: 600, y });
  const until = (cond) => { let g = 0; while (!cond() && g++ < 100000) p.clock.advance(50); return cond(); };
  const fail = [];
  // ronda 1
  addUnits(p.host, 400); addUnits(p.guest, 380);
  p.host.confirmReady(); p.pump(); p.guest.confirmReady(); p.pump();
  if (p.host.G.phase !== 'battle' || p.guest.G.phase !== 'battle') fail.push('ronda 1 no arrancó');
  // el host (4x) termina y pasa a planificar la ronda 2 mientras el guest (0.5x) sigue mirando la 1
  if (!until(() => p.host.G.phase === 'plan')) fail.push('host no llegó a la ronda 2');
  if (p.guest.G.phase !== 'battle') fail.push('el guest debía seguir en batalla, está en ' + p.guest.G.phase);
  addUnits(p.host, 410);
  p.host.confirmReady(); p.pump();                       // ready de la ronda 2 llega con el guest aún reproduciendo la 1
  if (p.guest.G.phase !== 'battle') fail.push('el ready adelantado alteró la fase del guest');
  if (p.log.guest.length !== 1) fail.push('el guest simuló de más: ' + p.log.guest.length);
  if (!until(() => p.guest.G.phase === 'plan')) fail.push('guest no llegó a la ronda 2');
  if (!p.guest.G.foeReady) fail.push('el ready adelantado se perdió en el guest');
  addUnits(p.guest, 390);
  p.guest.confirmReady(); p.pump();
  const same = JSON.stringify(p.log.host) === JSON.stringify(p.log.guest);
  if (p.log.host.length !== 2 || p.log.guest.length !== 2) fail.push(`sims host=${p.log.host.length} guest=${p.log.guest.length}, esperado 2`);
  if (!same) fail.push('las simulaciones de host y guest difieren');
  check('rondas: ready adelantado se bufferea y ambos simulan igual', fail.length === 0, fail.join('; ') || `2 sims idénticas en ambos lados`);
}

// (f) entrada hostil del rival: nada rompe la simulación ni la partida
{
  const { makePair, handshake } = require('./net');
  const p = makePair(); handshake(p);
  const fail = [];
  const hostile = [
    { id: '__proto__', x: 1, y: 300 }, { id: 'constructor', x: 1, y: 300 }, { id: 'nope', x: 1, y: 300 }, null, 5, 'x',
    { id: 'warden', lvl: 9999, x: NaN, y: Infinity }, { id: 'crawler', lvl: -3, x: -500, y: 99999, dmgFrac: 'abc' },
    { id: 'titan', lvl: 2, x: 500, y: 100, dmgFrac: 0.5 },
  ];
  const clean = p.host.sanitizeDeploy(hostile);
  if (clean.length !== 3) fail.push('esperaba 3 unidades válidas, hay ' + clean.length);
  for (const d of clean) {
    if (!(d.lvl >= 1 && d.lvl <= 8) || !isFinite(d.x) || !isFinite(d.y) || d.x < 0 || d.x > 1000 || d.y < 220 || d.y > 440) fail.push('unidad fuera de rango: ' + JSON.stringify(d));
  }
  if (p.host.sanitizeDeploy('basura') !== null || p.host.sanitizeDeploy({}) !== null) fail.push('no-arrays deben dar null');
  if (p.host.sanitizeDeploy(new Array(5000).fill({ id: 'crawler', x: 1, y: 300 })).length > 60) fail.push('no limita el tamaño');
  const t = p.host.sanitizeTech({ warden: true, longbow: 'yes', __proto__: { titan: true }, hacker: true });
  if (JSON.stringify(t) !== '{"warden":true}') fail.push('sanitizeTech: ' + JSON.stringify(t));
  // la sim corre con la entrada saneada sin lanzar y es determinista
  try { const a = p.host.simulate(clean, clean, {}, {}, 1), b = p.host.simulate(clean, clean, {}, {}, 1); if (JSON.stringify(a) !== JSON.stringify(b)) fail.push('sim no determinista con entrada saneada'); }
  catch (e) { fail.push('la sim lanzó: ' + e.message); }
  // mensajes basura por la red no cambian el estado
  p.host.G.myDeploy.push({ id: 'warden', lvl: 1, x: 300, y: 400 });
  for (const m of [null, 7, 'x', {}, { t: 'ready' }, { t: 'ready', round: 1, deploy: 'x' }, { t: 'ready', round: 1, deploy: [{ id: 'zzz' }] }, { t: 'seed', seed: 1 }, { t: 'hello', name: 'EVIL' }]) {
    try { p.host.onData(m); } catch (e) { fail.push('onData lanzó con ' + JSON.stringify(m) + ': ' + e.message); }
  }
  if (p.host.G.foeReady) fail.push('un ready inválido marcó al rival como listo');
  if (p.host.G.phase !== 'plan') fail.push('la fase cambió: ' + p.host.G.phase);
  check('entrada hostil: saneada, sin crashes ni cambios de estado', fail.length === 0, fail.join('; '));
}

// (g) salud de la conexión
{
  const { makePair, handshake } = require('./net');
  const fail = [];
  const addUnits = (m, y) => m.G.myDeploy.push({ id: 'warden', lvl: 1, x: 300, y }, { id: 'marauder', lvl: 1, x: 600, y });

  // 1. partida completa con velocidades muy distintas: nunca debe haber una desconexión falsa
  {
    const p = makePair(); handshake(p);
    p.host.G.battleSpeed = 4; p.guest.G.battleSpeed = 0.5;
    let g = 0;
    while (!(p.host.G.phase === 'over' && p.guest.G.phase === 'over') && g++ < 400000) {
      for (const m of [p.host, p.guest]) if (m.G.phase === 'plan' && !m.G.myReady) { addUnits(m, 400); m.confirmReady(); }
      p.pump(); p.clock.advance(50); p.pump();
    }
    if (!(p.host.G.phase === 'over' && p.guest.G.phase === 'over')) fail.push('la partida completa no terminó');
    if (p.log.lost.host || p.log.lost.guest) fail.push('desconexión falsa en partida normal: ' + JSON.stringify(p.log.lost));
    if (JSON.stringify(p.log.host) !== JSON.stringify(p.log.guest)) fail.push('simulaciones distintas a lo largo de la partida');
    if (p.host.G.winsMe !== p.guest.G.winsFoe || p.host.G.winsFoe !== p.guest.G.winsMe) fail.push('marcadores distintos');
  }
  // 2. silencio del rival: se detecta en ~15s y arranca la reconexión (la partida NO se corta); sin éxito en ~2min se da por perdida
  {
    const p = makePair(); handshake(p);
    for (let t = 0; t < 12000; t += 500) { p.clock.advance(500); p.pump(); }
    if (p.log.lost.host) fail.push('falso positivo con tráfico normal');
    p.queue.length = 0;
    for (let t = 0; t < 20000; t += 500) { p.clock.advance(500); p.queue.length = 0; }   // el rival no llega a nosotros
    if (p.log.lost.host !== 1 || !p.host.G.reconnecting || p.host.G.phase !== 'plan' || p.host.G.conn !== null) fail.push(`silencio: esperaba reconexión (lost=${p.log.lost.host}, reconnecting=${p.host.G.reconnecting}, fase=${p.host.G.phase})`);
    p.clock.advance(130000);
    if (p.host.G.phase !== 'over' || p.host.G.reconnecting) fail.push('tras ~2min sin reconectar debía terminar: ' + p.host.G.phase);
  }
  // 3. corte a mitad de combate: el combate local sigue (la sim es determinista); si no vuelve, la partida termina
  {
    const p = makePair(); handshake(p);
    addUnits(p.host, 400); addUnits(p.guest, 380);
    p.host.confirmReady(); p.pump(); p.guest.confirmReady(); p.pump();
    p.clock.advance(300);
    p.guest.connectionLost('Se cortó la conexión');
    if (!p.guest.G.reconnecting || p.guest.G.phase !== 'battle') fail.push(`corte en combate: reconnecting=${p.guest.G.reconnecting}, fase=${p.guest.G.phase}`);
    p.clock.advance(130000);
    if (p.guest.G.phase !== 'over') fail.push('fase tras agotar la reconexión: ' + p.guest.G.phase);
    if (p.log.guest.length !== 1) fail.push('simulaciones del guest: ' + p.log.guest.length);
  }
  // 4. volver al lobby limpia el estado y cancela timers pendientes
  {
    const p = makePair(); handshake(p);
    p.guest.G.battleSpeed = 4; p.host.G.battleSpeed = 4;
    addUnits(p.host, 400); addUnits(p.guest, 380);
    p.host.confirmReady(); p.pump(); p.guest.confirmReady(); p.pump();
    let g = 0; while (p.host.G.phase !== 'between' && p.host.G.phase !== 'over' && g++ < 5000) p.clock.advance(20);
    p.host.leaveToLobby();
    p.clock.advance(120000);
    const G = p.host.G;
    if (G.phase !== 'lobby' || G.myDeploy.length || G.conn || G.peer || G.isHost) fail.push('leaveToLobby no limpió: ' + G.phase);
    if (p.log.lost.host) fail.push('leaveToLobby no debería contar como conexión perdida');
  }
  // 5. una segunda conexión a una sala ocupada se rechaza
  {
    const p = makePair(); handshake(p);
    let closed = false; const before = p.host.G.conn;
    p.host.onIncoming({ close() { closed = true; }, on() {} });
    if (!closed || p.host.G.conn !== before) fail.push('no rechazó la conexión intrusa');
  }
  check('conexión: heartbeat, corte, volver al lobby, sala ocupada', fail.length === 0, fail.join('; '));
}

// (h) vista: cada jugador ve SU ejército abajo durante el combate (el guest se voltea solo al dibujar)
{
  const { makePair, handshake } = require('./net');
  const p = makePair(); handshake(p);
  const fail = [];
  p.host.G.myDeploy.push({ id: 'warden', lvl: 1, x: 300, y: 400 }, { id: 'marauder', lvl: 1, x: 700, y: 380 });
  p.guest.G.myDeploy.push({ id: 'warden', lvl: 1, x: 500, y: 410 }, { id: 'longbow', lvl: 1, x: 200, y: 390 });
  p.host.confirmReady(); p.pump(); p.guest.confirmReady(); p.pump();
  p.clock.advance(300);
  for (const who of ['host', 'guest']) {
    const first = p.log.views[who][0];
    if (!first) { fail.push(who + ': no se dibujó ningún frame'); continue; }
    const mine = first.ents.filter(e => e.side === 'me'), foe = first.ents.filter(e => e.side === 'foe');
    if (!mine.length || !foe.length) fail.push(who + ': faltan unidades en el primer frame');
    if (mine.some(e => e.y < 220)) fail.push(who + ': su ejército aparece arriba');
    if (foe.some(e => e.y > 220)) fail.push(who + ': el rival aparece abajo');
  }
  // y las posiciones de mi ejército en el primer frame coinciden con mi despliegue
  const g0 = p.log.views.guest[0].ents.filter(e => e.side === 'me').map(e => e.y).sort((a, b) => a - b);
  if (g0.length !== 2 || Math.abs(g0[0] - 390) > 6 || Math.abs(g0[1] - 410) > 6) fail.push('el guest no ve sus unidades donde las desplegó: ' + g0.map(Math.round).join());
  check('vista: cada jugador ve su ejército abajo en el combate', fail.length === 0, fail.join('; '));
}

// (i) modo MOVER: seleccionar, mover, deshacer, límites y bloqueo tras confirmar
{
  const { makePair, handshake } = require('./net');
  const p = makePair(); handshake(p);
  const m = p.host, G = m.G, fail = [];
  G.myDeploy.push({ id: 'warden', lvl: 1, x: 300, y: 400 }, { id: 'marauder', lvl: 1, x: 700, y: 380 });
  const gold0 = G.gold;
  G.mode = 'move';
  const u0 = G.myDeploy[0];
  m.onFieldTap({ x: 302, y: 398 });                           // elige el warden
  m.onFieldTap({ x: 500, y: 100 });                           // mitad enemiga: se rechaza
  if (u0.x !== 300 || u0.y !== 400) fail.push('se movió a la mitad enemiga');
  m.onFieldTap({ x: 520, y: 420 });                           // mitad propia: mueve
  if (Math.abs(u0.x - 520) > 1 || Math.abs(u0.y - 420) > 1) fail.push(`no se movió (${u0.x},${u0.y})`);
  if (G.gold !== gold0) fail.push('mover cobró créditos');
  m.onFieldTap({ x: 520, y: 420 }); m.onFieldTap({ x: 700, y: 382 });   // elegir A y tocar cerca de B: cambia la selección, no mueve
  if (u0.x !== 520 || G.myDeploy[1].x !== 700) fail.push('tocar cerca de otra unidad la movió');
  m.onFieldTap({ x: 5000, y: 5000 });                         // fuera de rango: se acota al campo
  if (!(G.myDeploy[1].x <= 1000 && G.myDeploy[1].y <= 440)) fail.push('no acotó al campo');
  const nPend = G.myPending.length;
  if (nPend < 2) fail.push('los movimientos no quedaron en la pila de deshacer: ' + nPend);
  for (let i = 0; i < nPend; i++) m.undoLast();
  if (u0.x !== 300 || u0.y !== 400 || G.myDeploy[1].x !== 700 || G.myDeploy[1].y !== 380) fail.push('deshacer no restauró posiciones');
  // tras confirmar el despliegue ya no se puede mover
  m.onFieldTap({ x: 300, y: 400 }); m.confirmReady();
  m.onFieldTap({ x: 600, y: 420 });
  if (u0.x !== 300) fail.push('se movió después de confirmar');
  check('mover: selecciona, mueve gratis, acota, deshace y se bloquea al confirmar', fail.length === 0, fail.join('; '));
}

// (j) reconexión a mitad de partida sobre una red PeerJS falsa (corte de conectividad, mensajes perdidos, intrusos)
{
  const { makeNetPair } = require('./net');
  const fail = [];
  const addUnits = (m, y) => m.G.myDeploy.push({ id: 'warden', lvl: 1, x: 300, y }, { id: 'marauder', lvl: 1, x: 600, y });
  const step = (p, ms) => p.clock.advance(ms);

  // A. un corte con los 'ready' en vuelo se recupera: ambos reenvían su último ready y simulan una sola vez, idéntico
  {
    const p = makeNetPair();
    if (p.host.G.phase !== 'plan' || p.guest.G.phase !== 'plan') fail.push(`A: no arrancó la partida (${p.host.G.phase}/${p.guest.G.phase})`);
    if (!p.host.G.token || p.host.G.token !== p.guest.G.token) fail.push('A: el token no se compartió');
    addUnits(p.host, 400); addUnits(p.guest, 380);
    p.host.confirmReady();                              // su ready queda en vuelo...
    p.net.kill();                                       // ...y se pierde con el corte
    step(p, 2);
    if (!p.host.G.reconnecting || !p.guest.G.reconnecting) fail.push('A: no entraron en reconexión');
    if (p.host.G.phase !== 'plan') fail.push('A: el corte alteró la fase del host');
    p.guest.confirmReady();                             // sin conexión: no se envía, pero queda guardado
    step(p, 7000);
    if (p.host.G.reconnecting || p.guest.G.reconnecting) fail.push('A: no se reconectaron');
    if (p.host.G.phase !== 'battle' || p.guest.G.phase !== 'battle') fail.push(`A: no entraron al combate tras reconectar (${p.host.G.phase}/${p.guest.G.phase})`);
    if (p.log.host.length !== 1 || p.log.guest.length !== 1 || JSON.stringify(p.log.host) !== JSON.stringify(p.log.guest)) fail.push('A: simulaciones distintas o duplicadas');
  }
  // B. partida completa con cortes repetidos: mismas simulaciones, mismo marcador, sin darse por vencidos
  {
    const p = makeNetPair(); p.host.G.battleSpeed = 4; p.guest.G.battleSpeed = 4;
    let kills = 0, g = 0, tick = 0;
    while (!(p.host.G.phase === 'over' && p.guest.G.phase === 'over') && g++ < 60000) {
      for (const m of [p.host, p.guest]) if (m.G.phase === 'plan' && !m.G.myReady && !m.G.reconnecting) { addUnits(m, 400); m.confirmReady(); }
      step(p, 100); tick++;
      if (tick % 25 === 0 && kills < 6) { p.net.kill(); kills++; }
    }
    const H = p.host.G, Gu = p.guest.G;
    if (!(H.phase === 'over' && Gu.phase === 'over')) fail.push(`B: la partida no terminó (${H.phase}/${Gu.phase})`);
    if (kills < 2) fail.push('B: el test no llegó a cortar la red');
    if (H.winsMe !== Gu.winsFoe || H.winsFoe !== Gu.winsMe || (H.winsMe < 3 && H.winsFoe < 3)) fail.push(`B: marcadores ${H.winsMe}-${H.winsFoe} vs ${Gu.winsMe}-${Gu.winsFoe}`);
    if (JSON.stringify(p.log.host) !== JSON.stringify(p.log.guest)) fail.push('B: simulaciones distintas entre host y guest');
    if (/No se pudo reconectar/.test(p.el(p.hl, 'phaseNote').textContent + p.el(p.gl, 'phaseNote').textContent)) fail.push('B: se rindió al reconectar');
  }
  // C. un intruso (sin token o con token falso) no puede secuestrar la partida; el rival legítimo sigue conectado
  {
    const p = makeNetPair(); const hostConn = p.host.G.conn;
    for (const md of [undefined, { token: 'falso' }, { token: '' }]) {
      const evil = new p.net.Peer(); step(p, 5);
      const c = evil.connect('ironsiege-v1-' + p.code, { metadata: md }); step(p, 30);
      if (c.open) fail.push('C: el intruso quedó conectado con ' + JSON.stringify(md));
    }
    if (p.host.G.conn !== hostConn || !hostConn.open) fail.push('C: el intruso desplazó al rival legítimo');
  }
  // D. se cae la señalización del host y también el enlace: el host se reengancha y el guest vuelve
  {
    const p = makeNetPair();
    p.net.signalingDown(p.host.G.peer); p.net.kill(); step(p, 7000);
    if (p.host.G.reconnecting || p.guest.G.reconnecting) fail.push('D: no se recuperó tras caer la señalización');
  }
  // E. un rival que avisó "estoy en segundo plano" tiene un plazo largo antes de darlo por perdido
  {
    const p = makeNetPair(); p.host.onData({ t: 'away' });
    p.net.dropping = true; p.net.blockConnect = true; p.net.silentClose = true; step(p, 60000);   // el guest desaparece sin cerrar nada
    if (p.host.G.reconnecting) fail.push('E: dio por perdido a un rival ausente demasiado pronto');
    step(p, 70000);
    if (!p.host.G.reconnecting && p.host.G.phase !== 'over') fail.push('E: nunca detectó la pérdida del rival ausente');
  }
  check('reconexión: corte con ready perdido, partida con cortes, intrusos, señalización, rival ausente', fail.length === 0, fail.join('; '));
}

// (k) renderizador con requestAnimationFrame: interpola sin romper, acota las partículas y limpia al terminar
{
  const { makePair, handshake } = require('./net');
  const fail = [];
  const addUnits = (m, y) => m.G.myDeploy.push({ id: 'crawler', lvl: 1, x: 300, y }, { id: 'longbow', lvl: 2, x: 500, y }, { id: 'vulcan', lvl: 1, x: 700, y }, { id: 'titan', lvl: 1, x: 400, y: y - 20 });
  for (const level of ['high', 'low', 'off']) {
    const p = makePair({ raf: true }); handshake(p);
    if (!p.host.HAS_RAF) fail.push('el sandbox no activó rAF');
    for (const m of [p.host, p.guest]) { m.setFx(level, false); m.G.battleSpeed = 2; }
    addUnits(p.host, 400); addUnits(p.guest, 380);
    p.host.confirmReady(); p.pump(); p.guest.confirmReady(); p.pump();
    let maxLive = 0, g = 0;
    while (p.host.G.phase !== 'plan' && p.host.G.phase !== 'over' && g++ < 20000) {
      p.clock.advance(16); p.pump();
      maxLive = Math.max(maxLive, p.host.P.live, p.guest.P.live);
    }
    const cap = p.host.FXQ[level].parts;
    if (g >= 20000) fail.push(`${level}: el combate no terminó`);
    if (maxLive > cap) fail.push(`${level}: partículas ${maxLive} > tope ${cap}`);
    if (level === 'off' && maxLive !== 0) fail.push('con efectos OFF no deben crearse partículas');
    if (level === 'high' && maxLive === 0) fail.push('con efectos ALTO nunca hubo partículas');
    if (p.log.battleDraws.host < 20 || p.log.battleDraws.guest < 20) fail.push(`${level}: pocos frames dibujados (${p.log.battleDraws.host}/${p.log.battleDraws.guest})`);
    if (JSON.stringify(p.log.host) !== JSON.stringify(p.log.guest)) fail.push(`${level}: los efectos alteraron la simulación`);
    p.clock.advance(3000);                                      // el loop se detiene al apagarse los efectos
    if (p.host.P.live !== 0) fail.push(`${level}: quedaron partículas vivas tras el combate`);
    if (p.host.G._bt) fail.push(`${level}: _bt no se limpió al empezar la ronda siguiente`);
  }
  check('renderizador: rAF, tope de partículas por calidad, sin alterar la simulación, limpieza', fail.length === 0, fail.join('; '));
}

// --report: tabla de winrates entre todos los tipos y unidades
if (process.argv.includes('--report')) {
  console.log('\nTriángulo por presupuesto (% victorias del que debería ganar):');
  for (const budget of [300, 500, 800, 1200, 2000, 3000])
    console.log(`  ${String(budget).padStart(5)}◈  ` + TRI.map(([a, b]) => `${a}>${b} ${(duelWinrate(a, b, 40, budget).rate * 100).toFixed(0)}%`).join('   '));
  const types = ['swarm', 'heavy', 'ranged', 'assault'];
  console.log('\nWinrate por tipo (fila vs columna, presupuesto 800, 40 duelos):');
  for (const a of types) console.log(a.padEnd(8), types.map(b => a === b ? '  -  ' : (duelWinrate(a, b).rate * 100).toFixed(0).padStart(4) + '%').join(' '));
  console.log('\nWinrate por unidad (fila vs columna, 40 duelos):');
  const ids = Object.keys(UNITS);
  console.log(''.padEnd(9), ids.map(i => i.slice(0, 7).padStart(8)).join(''));
  for (const a of ids) {
    const row = ids.map(b => {
      if (a === b) return '       -';
      const rng = makeRNG(99); let w = 0;
      for (let k = 0; k < 40; k++) {
        const A = buildArmy(rng, [a], 800), B = buildArmy(rng, [b], 800);
        const aH = k % 2 === 0;
        const r = aH ? simulate(A, B, {}, {}, 5000 + k) : simulate(B, A, {}, {}, 5000 + k);
        const s = aH ? 'host' : 'guest';
        w += r.winner === s ? 1 : r.winner === 'draw' ? 0.5 : 0;
      }
      return ((w / 40) * 100).toFixed(0).padStart(7) + '%';
    });
    console.log(a.padEnd(9), row.join(''));
  }
  console.log('\nFusión (L2 vs 2×L1 del mismo costo), por unidad:');
  for (const id of ids) {
    const u = UNITS[id]; const rng = makeRNG(5); let w = 0;
    for (let k = 0; k < 40; k++) {
      const pos = () => ({ x: 200 + rng() * 600, y: 260 + rng() * 150 });
      const L2 = [{ id, lvl: 2, ...pos() }], two = [{ id, lvl: 1, ...pos() }, { id, lvl: 1, ...pos() }];
      const aH = k % 2 === 0;
      const r = aH ? simulate(L2, two, {}, {}, 800 + k) : simulate(two, L2, {}, {}, 800 + k);
      w += r.winner === (aH ? 'host' : 'guest') ? 1 : 0;
    }
    console.log(`  ${id.padEnd(9)} L2 gana ${(w / 40 * 100).toFixed(0)}% vs 2×L1 (mismo costo)`);
  }
}

console.log(failed ? `\n${failed} test(s) fallaron` : '\nTodo OK');
process.exit(failed ? 1 : 0);
