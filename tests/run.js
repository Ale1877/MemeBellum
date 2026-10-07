// Tests de MemeBellum. Uso: node tests/run.js [--report]
const fs = require('fs');
const vm = require('vm');
const { loadGame, extractScript, HTML_PATH } = require('./load');

let failed = 0;
const pending = [];                                   // tests asíncronos (códec con streams)
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

// (l) resumen de batalla: el daño efectivo que hace un bando iguala la vida que pierde el otro (conservación)
{
  const { makePair } = require('./net');
  const p = makePair(); const m = p.host, fail = [];
  const mk = (ids, y) => ids.map((id, i) => ({ id, lvl: 1 + (i % 2), x: 120 + i * 130, y: y + (i % 3) * 20 }));
  for (let k = 0; k < 12; k++) {
    const H = mk(['crawler', 'warden', 'longbow', 'vulcan', 'marauder', 'titan'].slice(0, 3 + k % 4), 380);
    const Gd = mk(['titan', 'crawler', 'vulcan', 'longbow', 'warden'].slice(0, 3 + (k + 1) % 3), 380);
    const tech = k % 2 ? { warden: true, longbow: true } : {};
    const r = m.simulate(H, Gd, tech, {}, 900 + k);
    const startHP = (dep, side, t) => m.expand(dep, side, t).reduce((s, e) => s + e.hp, 0);
    const survHP = (surv) => Object.values(surv).reduce((s, x) => s + x.hp, 0);
    const dealt = side => r.stats.filter(e => e.side === side).reduce((s, e) => s + e.dealt, 0);
    const lostHost = startHP(H, 'host', tech) - survHP(r.hostSurv), lostGuest = startHP(Gd, 'guest', {}) - survHP(r.guestSurv);
    if (Math.abs(dealt('guest') - lostHost) > r.stats.length) fail.push(`duelo ${k}: daño del guest ${dealt('guest')} vs vida perdida del host ${Math.round(lostHost)}`);
    if (Math.abs(dealt('host') - lostGuest) > r.stats.length) fail.push(`duelo ${k}: daño del host ${dealt('host')} vs vida perdida del guest ${Math.round(lostGuest)}`);
    const kills = side => r.stats.filter(e => e.side === side).reduce((s, e) => s + e.kills, 0);
    const dead = side => r.stats.filter(e => e.side !== side && !e.alive).length;
    if (kills('host') !== dead('host') || kills('guest') !== dead('guest')) fail.push(`duelo ${k}: bajas ${kills('host')}/${kills('guest')} vs muertos ${dead('host')}/${dead('guest')}`);
    const sum = m.buildSummary(r.stats, 'host');
    if (sum.totMe.dealt !== dealt('host') || sum.totFoe.dealt !== dealt('guest')) fail.push(`duelo ${k}: buildSummary no suma igual`);
    if (sum.mvp && !(sum.mvp.dealt >= Math.max(...sum.me.map(x => x.dealt), ...sum.foe.map(x => x.dealt)))) fail.push(`duelo ${k}: MVP incorrecto`);
    try { m.renderSummary(sum, 1); } catch (e) { fail.push('renderSummary lanzó: ' + e.message); }
  }
  check('resumen: conservación de daño, bajas = muertos, MVP y render', fail.length === 0, fail.slice(0, 3).join('; '));
}

// (m) audio: sin contexto/silenciado no hace nada; tope de voces; límite por sonido; todas las voces terminan
{
  const { makePair, handshake } = require('./net');
  const p = makePair({ raf: true, audio: true }); handshake(p);
  const A = p.host.AUD, fail = [], cnt = p.audio.count;
  const nodes = () => cnt.osc + cnt.src;
  p.host.sfx('click'); if (nodes() !== 0) fail.push('sonó sin AudioContext (falta gesto del usuario)');
  p.host.audioInit(); if (!A.ctx) fail.push('audioInit no creó el contexto');
  p.clock.advance(100);
  let n0 = nodes(); for (let i = 0; i < 1000; i++) p.host.sfx('shot_titan');
  if (nodes() - n0 > 2) fail.push('límite por sonido: 1000 llamadas simultáneas crearon ' + (nodes() - n0) + ' voces');
  p.clock.advance(500);
  A.voices += A.MAXV; n0 = nodes(); p.host.sfx('click'); p.host.sfx('shot_vulcan');
  if (nodes() !== n0) fail.push('con el tope de voces lleno igual sonaron sonidos comunes');
  p.clock.advance(200); p.host.sfx('boom_big'); if (nodes() === n0) fail.push('las explosiones (prioritarias) deben sonar con el tope lleno');
  A.voices -= A.MAXV; p.clock.advance(1000);
  p.host.setSnd(false, false); n0 = nodes(); p.clock.advance(500); p.host.sfx('boom'); if (nodes() !== n0) fail.push('silenciado igual sonó');
  p.host.setSnd(true, false);
  A.ctx.state = 'suspended'; p.clock.advance(500); n0 = nodes(); p.host.sfx('boom'); if (nodes() !== n0) fail.push('suspendido igual sonó');
  A.ctx.state = 'running';
  // una ronda completa con audio activo: no lanza y todas las voces terminan
  for (const m of [p.host, p.guest]) { m.audioInit(); m.G.battleSpeed = 2; m.G.myDeploy.push({ id: 'crawler', lvl: 1, x: 300, y: 400 }, { id: 'titan', lvl: 1, x: 500, y: 400 }, { id: 'longbow', lvl: 1, x: 650, y: 390 }); }
  p.host.confirmReady(); p.pump(); p.guest.confirmReady(); p.pump();
  n0 = nodes(); let g = 0;
  while (p.host.G.phase !== 'plan' && p.host.G.phase !== 'over' && g++ < 20000) { p.clock.advance(16); p.pump(); }
  if (nodes() - n0 < 10) fail.push('el combate casi no generó sonido (' + (nodes() - n0) + ' voces)');
  p.clock.advance(3000);
  if (A.voices !== 0) fail.push('quedaron voces sin terminar: ' + A.voices);
  check('audio: gesto previo, límite por sonido, tope de voces, silencio y cierre de voces', fail.length === 0, fail.join('; '));
}

// (n) temporizador de planificación: confirma solo al vencer (incluso con ejército vacío), sin tocar la simulación
{
  const { makePair, handshake } = require('./net');
  const fail = [];
  const p = makePair({ raf: true }); handshake(p);
  const H = p.host.G, Gu = p.guest.G;
  const run = (ms) => { for (let t = 0; t < ms; t += 500) { p.clock.advance(500); p.pump(); } };   // con tráfico: los latidos mantienen la conexión
  H.myDeploy.push({ id: 'warden', lvl: 1, x: 300, y: 400 }, { id: 'longbow', lvl: 1, x: 600, y: 400 });   // el guest no despliega nada
  run(80000);
  if (H.myReady || Gu.myReady || H.phase !== 'plan') fail.push('confirmó antes de que venciera el tiempo (80s de 90s)');
  run(11000);
  if (!H.myReady || !Gu.myReady) fail.push(`no se auto-confirmó al vencer (${H.myReady}/${Gu.myReady})`);
  if (Gu.sentReady && Gu.sentReady.deploy.length !== 0) fail.push('el guest debía enviar un ejército vacío');
  let g = 0; while (H.phase === 'battle' && g++ < 5000) run(500);
  if (p.log.host.length !== 1 || p.log.guest.length !== 1 || JSON.stringify(p.log.host) !== JSON.stringify(p.log.guest)) fail.push('simulaciones distintas con ejército vacío');
  if (p.log.host[0].winner !== 'host') fail.push('con el guest sin ejército debía ganar el host: ' + p.log.host[0].winner);
  run(3000);
  if (H.phase !== 'plan' || H.round !== 2) fail.push('no pasó a la ronda 2 (' + H.phase + ' r' + H.round + ')');
  // ronda 2: el timer es de 60s; confirmar a mano lo detiene (no se confirma dos veces)
  H.myDeploy.length || H.myDeploy.push({ id: 'warden', lvl: 1, x: 300, y: 400 });
  p.host.confirmReady(); p.pump();
  const sims = p.log.host.length; run(70000);
  if (p.log.host.length !== sims + 1) fail.push('ronda 2: simulaciones inesperadas ' + (p.log.host.length - sims));
  // un ready vacío real del rival es válido; uno con unidades inválidas no
  const q = makePair({ raf: true }); handshake(q);
  q.host.onData({ t: 'ready', round: 1, deploy: [], tech: {} });
  if (!q.host.G.foeReady) fail.push('un despliegue vacío legítimo fue rechazado');
  const r = makePair({ raf: true }); handshake(r);
  r.host.onData({ t: 'ready', round: 1, deploy: [{ id: 'zzz' }], tech: {} });
  if (r.host.G.foeReady) fail.push('un despliegue de unidades inválidas fue aceptado');
  check('temporizador: auto-confirma al vencer, acepta ejército vacío y mantiene la simulación idéntica', fail.length === 0, fail.join('; '));
}

// (o) revancha directa: ambos deben pedirla, semillas nuevas idénticas, estado limpio y partida jugable
{
  const { makePair, handshake } = require('./net');
  const p = makePair({ raf: true }); handshake(p);
  const H = p.host, Gu = p.guest, fail = [];
  const run = (ms) => { for (let t = 0; t < ms; t += 250) { p.clock.advance(250); p.pump(); } };
  const seed0 = H.G.seed;
  // estado "partida terminada" con restos de la anterior que NO deben heredarse
  for (const m of [H, Gu]) { m.G.phase = 'over'; m.G.income = 520; m.G.round = 6; m.G.foeLastDeploy = [{ id: 'titan', lvl: 2, x: 1, y: 300 }]; m.G.foeLastTech = { titan: true }; }
  H.G.winsMe = 3; H.G.winsFoe = 1; Gu.G.winsMe = 1; Gu.G.winsFoe = 3;
  H.requestRematch(); p.pump(); run(500);
  if (H.G.phase !== 'over' || Gu.G.phase !== 'over') fail.push('arrancó con un solo jugador pidiendo la revancha');
  Gu.requestRematch(); p.pump(); run(1000);
  for (const [n, m] of [['host', H], ['guest', Gu]]) {
    const G = m.G;
    if (G.phase !== 'plan' || G.round !== 1 || G.winsMe !== 0 || G.winsFoe !== 0) fail.push(`${n}: no reinició (fase ${G.phase}, ronda ${G.round}, ${G.winsMe}-${G.winsFoe})`);
    if (G.income !== 200 || G.gold !== 200) fail.push(`${n}: economía heredada (ingreso ${G.income}, oro ${G.gold})`);
    if (G.foeLastDeploy !== null || Object.keys(G.foeLastTech).length) fail.push(`${n}: heredó el intel de la partida anterior`);
    if (G.rematchMe || G.foeRematch) fail.push(`${n}: banderas de revancha sin limpiar`);
  }
  if (H.G.seed !== Gu.G.seed) fail.push('semillas distintas tras la revancha');
  if (H.G.seed === seed0) fail.push('la revancha reutilizó la semilla anterior');
  // la nueva partida es jugable y las simulaciones coinciden
  for (const m of [H, Gu]) { m.G.battleSpeed = 4; m.G.myDeploy.push({ id: 'warden', lvl: 1, x: 300, y: 400 }); m.confirmReady(); }
  p.pump(); run(25000);
  if (p.log.host.length !== 1 || JSON.stringify(p.log.host) !== JSON.stringify(p.log.guest)) fail.push('la partida nueva no simuló igual en ambos lados');
  // mensajes fuera de lugar se ignoran: rseed sin que ambos pidan revancha; revancha en el lobby
  const q = makePair({ raf: true }); handshake(q);
  q.guest.G.phase = 'over'; q.guest.onData({ t: 'rseed', seed: 123 });
  if (q.guest.G.phase !== 'over') fail.push('un rseed sin revancha mutua reinició la partida');
  const r = makePair({ raf: true }); handshake(r); r.host.G.phase = 'lobby'; r.host.onData({ t: 'rematch' });
  if (r.host.G.foeRematch) fail.push('aceptó revancha estando en el lobby');
  check('revancha: pedido mutuo, semillas nuevas idénticas, estado limpio y juego normal', fail.length === 0, fail.join('; '));
}

// (p) replays: grabación idéntica en ambas máquinas, re-simulación exacta, códec, entrada hostil, visor y almacenamiento
pending.push((async () => {
  const { makePair, handshake } = require('./net');
  const zlib = require('zlib');
  const fail = [];
  const p = makePair({ raf: true }); handshake(p);
  const H = p.host, Gu = p.guest;
  H.G.battleSpeed = 4; Gu.G.battleSpeed = 4;
  const run = (ms) => { for (let t = 0; t < ms; t += 250) { p.clock.advance(250); p.pump(); } };
  const add = (m, y) => m.G.myDeploy.push({ id: 'warden', lvl: 1, x: 300.4, y }, { id: 'longbow', lvl: 1, x: 612.7, y }, { id: 'crawler', lvl: 1, x: 450.1, y: y - 20 });
  let g = 0;
  while (!(H.G.phase === 'over' && Gu.G.phase === 'over') && g++ < 400) {
    for (const m of [H, Gu]) if (m.G.phase === 'plan' && !m.G.myReady) { if (m.G.myDeploy.length < 3) add(m, 400); m.confirmReady(); }
    run(500);
  }
  const rh = H.Rec.cur, rg = Gu.Rec.cur;
  if (!rh.rounds.length) fail.push('no se grabó ninguna ronda');
  if (JSON.stringify(rh.rounds) !== JSON.stringify(rg.rounds)) fail.push('host y guest grabaron rondas distintas');
  if (rh.host !== 'H' || rh.guest !== 'G' || rg.host !== 'H' || rg.guest !== 'G') fail.push(`nombres: ${rh.host}/${rh.guest} y ${rg.host}/${rg.guest}`);
  // re-simular lo grabado da exactamente lo que se jugó
  rh.rounds.forEach((r, k) => {
    const x = H.simulate(r.hd, r.gd, r.ht, r.gt, r.seed), played = p.log.host[k];
    if (x.winner !== r.w || x.winner !== played.winner || x.hostHP !== played.hostHP || x.guestHP !== played.guestHP) fail.push(`ronda ${k + 1}: la re-simulación difiere de lo jugado`);
  });
  // se guardó en el almacenamiento y sobrevive al saneamiento sin cambios
  const stored = H.replaysLoad();
  if (stored.length !== 1 || stored[0].rounds.length !== rh.rounds.length) fail.push('no quedó guardado en localStorage');
  const clean = H.sanitizeReplay(JSON.parse(JSON.stringify(rh)));
  if (!clean || JSON.stringify(clean.rounds) !== JSON.stringify(rh.rounds)) fail.push('sanitizeReplay alteró una grabación legítima (rompería el determinismo)');
  // códec: gzip y fallback sin CompressionStream
  const codec = async () => {
    const f2 = [];
    const code = await H.replayEncode(rh);
    if (!code.startsWith('g1.')) f2.push('no usó gzip');
    const back = await H.replayDecode(code);
    if (!back || JSON.stringify(back.rounds) !== JSON.stringify(rh.rounds)) f2.push('ida y vuelta gzip distinta');
    if (code.length > 14000) f2.push('código demasiado largo: ' + code.length);
    const viaLink = await H.replayDecode('https://x.test/index.html#replay=' + code);
    if (!viaLink) f2.push('no decodificó el enlace completo');
    p.hl.ctx.CompressionStream = undefined;
    const plain = await H.replayEncode(rh);
    if (!plain.startsWith('p1.')) f2.push('sin CompressionStream debía usar el formato plano');
    const back2 = await H.replayDecode(plain);
    if (!back2 || JSON.stringify(back2.rounds) !== JSON.stringify(rh.rounds)) f2.push('ida y vuelta plana distinta');
    p.hl.ctx.CompressionStream = CompressionStream;
    // entrada hostil
    const bad = [null, '', 'basura', 'g1.', 'g1.AAAA', 'p1.' + Buffer.from('no es json').toString('base64url'), 'x1.' + code.slice(3), 'g1.' + 'A'.repeat(80000)];
    for (const b of bad) if (await H.replayDecode(b) !== null) f2.push('aceptó entrada inválida: ' + String(b).slice(0, 20));
    const bomb = 'g1.' + zlib.gzipSync(Buffer.alloc(5_000_000, 32)).toString('base64url');          // bomba de descompresión (5MB)
    if (await H.replayDecode(bomb) !== null) f2.push('aceptó una bomba de descompresión');
    const mk = (mut) => { const o = JSON.parse(JSON.stringify(rh)); mut(o); return 'p1.' + Buffer.from(JSON.stringify(o)).toString('base64url'); };
    for (const [n, mut] of [['seed NaN', o => { o.rounds[0].seed = 'x'; }], ['demasiadas rondas', o => { o.rounds = new Array(30).fill(o.rounds[0]); }], ['sin rondas', o => { o.rounds = []; }], ['versión', o => { o.v = 9; }], ['deploy no es lista', o => { o.rounds[0].hd = 'x'; }]])
      if (await H.replayDecode(mk(mut)) !== null) f2.push('aceptó replay inválido: ' + n);
    const evil = await H.replayDecode(mk(o => { o.host = '<img src=x onerror=alert(1)>'; o.rounds[0].hd.push({ id: '__proto__', x: 1, y: 300 }, { id: 'warden', lvl: 9999, x: 1e9, y: -5 }); }));
    if (!evil || evil.rounds[0].hd.length !== rh.rounds[0].hd.length + 1 || evil.rounds[0].hd.some(d => d.lvl > 8 || d.x > 1000 || d.y < 220)) f2.push('no saneó unidades hostiles dentro del replay');
    return f2;
  };
  {
    const f2 = await codec();
    fail.push(...f2);
    // visor: reproduce, autoavanza, permite saltar, bloquea si hay sala y restaura el estado
    const v = makePair({ raf: true }); const V = v.host;
    V.G.phase = 'lobby'; V.G.name = 'YO'; V.G.foeName = 'OTRO'; V.G.isHost = false; V.G.peer = {};
    if (V.replayOpen(rh)) fail.push('el visor abrió con una sala activa');
    V.G.peer = null;
    V.G.battleSpeed = 4;
    if (!V.replayOpen(JSON.parse(JSON.stringify(rh)))) fail.push('el visor no abrió');
    if (V.G.phase !== 'replay') fail.push('fase del visor: ' + V.G.phase);
    v.clock.advance(60000);
    if (V.RP.round !== rh.rounds.length - 1) fail.push(`no avanzó solo hasta la última ronda (${V.RP.round}/${rh.rounds.length - 1})`);
    V.replaySeek(3); if (V.RP.i !== 3 || V.RP.playing) fail.push('replaySeek no pausó en el frame pedido');
    V.replayToggle(); if (!V.RP.playing) fail.push('replayToggle no reanudó');
    V.replayClose();
    if (V.G.phase !== 'lobby' || V.G.name !== 'YO' || V.G.foeName !== 'OTRO' || V.G.isHost !== false || V.G._bt) fail.push('replayClose no restauró el estado');
    // almacenamiento: tope de 12, y no se rompe si el almacenamiento falla
    for (let i = 0; i < 15; i++) V.replaySave({ ...JSON.parse(JSON.stringify(rh)), id: 'id' + i });
    if (V.replaysLoad().length !== V.REPLAY_MAX) fail.push('tope de replays: ' + V.replaysLoad().length);
    const t = makePair({ raf: true, storageThrows: true });
    try { t.host.replaySave(JSON.parse(JSON.stringify(rh))); } catch (e) { fail.push('replaySave lanzó con almacenamiento lleno: ' + e.message); }
    check('replays: grabación idéntica, re-simulación exacta, códec, entrada hostil, visor y almacenamiento', fail.length === 0, fail.join('; '));
  }
})());

// (q) huella de la simulación: si las reglas cambian, los replays viejos dejan de coincidir -> hay que subir SIM_VERSION
{
  const api2 = loadGame(['SIM_VERSION', 'simulate', 'makeRNG', 'UNITS']).api;
  const rng = api2.makeRNG(20240607), ids = Object.keys(api2.UNITS), outs = [];
  for (let k = 0; k < 24; k++) {
    const mk = () => Array.from({ length: 2 + (k % 5) }, () => ({ id: ids[Math.floor(rng() * ids.length)], lvl: 1 + Math.floor(rng() * 3), x: 40 + rng() * 920, y: 240 + rng() * 180 }));
    const r = api2.simulate(mk(), mk(), k % 2 ? { warden: true, crawler: true } : {}, k % 3 ? { longbow: true } : {}, 500 + k);
    outs.push([r.winner, r.hostHP, r.guestHP, JSON.stringify(r.hostSurv), JSON.stringify(r.guestSurv), r.frames.length]);
  }
  let h = 0x811c9dc5; for (const ch of JSON.stringify(outs)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  const hash = h.toString(16), file = require('path').join(__dirname, 'sim-fingerprint.json');
  if (process.argv.includes('--update-fingerprint')) { fs.writeFileSync(file, JSON.stringify({ simVersion: api2.SIM_VERSION, hash }, null, 2) + '\n'); console.log('huella actualizada:', hash, 'SIM_VERSION', api2.SIM_VERSION); }
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const same = saved.hash === hash, bumped = saved.simVersion !== api2.SIM_VERSION;
  check('huella de simulación: cambiar las reglas exige subir SIM_VERSION', same && !bumped || (!same && bumped && false),
    same ? (bumped ? `SIM_VERSION cambió (${saved.simVersion}→${api2.SIM_VERSION}) sin cambiar las reglas: corré --update-fingerprint` : `v${api2.SIM_VERSION} ${hash}`)
         : `la simulación cambió (${saved.hash} → ${hash}). Subí SIM_VERSION (hoy ${api2.SIM_VERSION}) y corré: node tests/run.js --update-fingerprint`);
}

// (r) matchmaking sin servidor: buzones con ID fijo sobre una red PeerJS falsa con varias máquinas buscando a la vez
{
  const { makeCrowd } = require('./net');
  const fail = [];
  const phases = c => c.ms.map(m => m.G.phase[0]).join('');
  const slotsLeft = c => [...c.net.peers.keys()].filter(k => k.startsWith('ironsiege-v1-q-'));
  const pairsOk = (c, who, label) => {
    const seeds = {}; for (const m of who) (seeds[m.G.seed] = seeds[m.G.seed] || []).push(m);
    for (const [seed, grp] of Object.entries(seeds)) {
      const hosts = grp.filter(m => m.G.isHost).length;
      if (grp.length !== 2 || hosts !== 1) fail.push(`${label}: grupo con semilla ${seed} mal formado (${grp.length} jugadores, ${hosts} hosts)`);
    }
  };

  // 1. dos jugadores buscan a la vez -> se emparejan y la partida arranca; el buzón se libera
  { const c = makeCrowd(2); c.ms.forEach(m => m.api.mmStart()); c.run(30000);
    if (phases(c) !== 'pp') fail.push('1: no arrancó la partida (' + phases(c) + ')');
    pairsOk(c, c.ms, '1');
    if (c.ms[0].G.foeName === 'RIVAL' || c.ms[0].G.foeName === c.ms[0].G.name) fail.push('1: no intercambiaron nombres');
    if (slotsLeft(c).length) fail.push('1: quedaron buzones ocupados: ' + slotsLeft(c));
    if (c.ms.some(m => m.MM.on)) fail.push('1: la búsqueda no se detuvo al emparejar'); }
  // 2. seis a la vez -> tres partidas
  { const c = makeCrowd(6); c.ms.forEach(m => m.api.mmStart()); c.run(60000);
    if (phases(c) !== 'pppppp') fail.push('2: no se emparejaron todos (' + phases(c) + ')');
    pairsOk(c, c.ms, '2'); if (slotsLeft(c).length) fail.push('2: buzones sin liberar: ' + slotsLeft(c)); }
  // 3. cinco -> dos partidas y uno sigue buscando; llega un sexto y se juntan
  { const c = makeCrowd(5); c.ms.forEach(m => m.api.mmStart()); c.run(60000);
    const playing = c.ms.filter(m => m.G.phase === 'plan'), waiting = c.ms.filter(m => m.G.phase === 'lobby');
    if (playing.length !== 4 || waiting.length !== 1 || !waiting[0].MM.on) fail.push('3: esperaba 4 jugando y 1 buscando (' + phases(c) + ')');
    const late = c.add('Tardío'); late.api.mmStart(); c.run(40000);
    if (late.G.phase !== 'plan' || waiting[0].G.phase !== 'plan' || late.G.seed !== waiting[0].G.seed) fail.push('3: el que llegó tarde no se emparejó con el que esperaba'); }
  // 4. dueño muerto en el buzón 0 (id registrado que nunca responde): se saltea y se emparejan igual
  { const c = makeCrowd(2); const zombie = new c.net.Peer('ironsiege-v1-q-0'); c.run(10);
    c.ms.forEach(m => m.api.mmStart()); c.run(70000);
    if (phases(c) !== 'pp') fail.push('4: con un buzón zombi no se emparejaron (' + phases(c) + ')'); pairsOk(c, c.ms, '4'); }
  // 5. espera "varada" en el buzón 1: al liberarse el 0 y llegar otro jugador, el que espera re-escanea y se encuentran
  { const c = makeCrowd(2); const zombie = new c.net.Peer('ironsiege-v1-q-0'); c.run(10);
    c.ms[0].api.mmStart(); c.run(9000);
    if (c.ms[0].MM.slot < 1) fail.push('5: el primero debía quedar esperando en un buzón >0 (slot ' + c.ms[0].MM.slot + ')');
    zombie.destroy(); c.run(500); c.ms[1].api.mmStart(); c.run(40000);
    if (phases(c) !== 'pp') fail.push('5: no se encontraron tras liberarse el buzón 0 (' + phases(c) + ')'); }
  // 6. cancelar libera todo y deja el estado limpio
  { const c = makeCrowd(1); const m = c.ms[0]; m.api.mmStart(); c.run(3000);
    if (!slotsLeft(c).length) fail.push('6: no reclamó un buzón al esperar');
    m.api.mmCancel(); c.run(500);
    if (slotsLeft(c).length || m.MM.on || m.G.peer || m.G.phase !== 'lobby') fail.push('6: cancelar no limpió (buzones ' + slotsLeft(c) + ', peer ' + !!m.G.peer + ')');
    m.api.mmStart(); c.run(2000); if (!m.MM.on) fail.push('6: no pudo volver a buscar'); }
  // 7. entradas hostiles: un mensaje basura no desarma al que espera; un "dueño" que manda códigos falsos no cuelga a nadie
  { const c = makeCrowd(1); c.ms[0].api.mmStart(); c.run(3000);
    const evil = new c.net.Peer(); c.run(20);
    for (const junk of [null, 7, 'x', {}, { t: 'ready' }, { t: 'mm_hello_x' }, { t: 'mm_room', code: '../../etc' }]) { const cn = evil.connect('ironsiege-v1-q-0', {}); c.run(30); cn.send(junk); c.run(30); }
    if (!c.ms[0].MM.on || c.ms[0].MM.slot !== 0 || c.ms[0].MM.pairing) fail.push('7: basura desarmó al que espera (slot ' + c.ms[0].MM.slot + ', pairing ' + c.ms[0].MM.pairing + ')');
    c.ms[0].api.mmCancel(); c.run(200); }
  { const c = makeCrowd(2);
    const liar = new c.net.Peer('ironsiege-v1-q-0'); c.run(10);
    liar.on('connection', cn => cn.on('open', () => cn.send({ t: 'mm_room', code: 'AAAAAA' })));   // código con formato válido pero sala inexistente
    c.ms.forEach(m => m.api.mmStart()); c.run(90000);
    if (phases(c) !== 'pp') fail.push('7b: un buzón mentiroso impidió el emparejamiento (' + phases(c) + ')'); }
  // 8. la partida emparejada es una partida normal: simulan igual
  { const c = makeCrowd(2); c.ms.forEach(m => m.api.mmStart()); c.run(30000);
    const [a, b] = c.ms; if (a.G.seed !== b.G.seed || a.G.seed === 0) fail.push('8: semillas distintas'); if (a.G.token !== b.G.token || !a.G.token) fail.push('8: sin token compartido'); }
  check('matchmaking: emparejar, carreras, zombis, esperas varadas, cancelar y entradas hostiles', fail.length === 0, fail.join('; '));
}

// (s) jugar con un amigo: crear sala + código, unirse (código en minúsculas), código inexistente, y convivencia con la búsqueda rápida
{
  const { makeNetPair, makeCrowd } = require('./net');
  const fail = [];
  // crear + unirse por código
  const p = makeNetPair();
  if (p.host.G.phase !== 'plan' || p.guest.G.phase !== 'plan') fail.push(`no arrancó la partida privada (${p.host.G.phase}/${p.guest.G.phase})`);
  if (!/^[A-Z0-9]{6}$/.test(p.code)) fail.push('código de sala con formato inesperado: ' + p.code);
  if (p.host.G.seed !== p.guest.G.seed || !p.host.G.token) fail.push('semilla/token distintos en la sala privada');
  // tres máquinas: A crea sala, B busca, C usa el código de A en minúsculas, con un código inexistente primero
  const c = makeCrowd(3); const [A, B, C] = c.ms; const el = (m, id) => m.ctx.document.getElementById(id);
  A.api.hostCreate(); c.run(500);
  const room = A.G.peer && A.G.peer.id, code = el(A, 'roomCode').textContent;
  if (!room || room.includes('-q-')) fail.push('la sala privada no debe usar un buzón de búsqueda: ' + room);
  B.api.mmStart(); c.run(20000);
  if (A.G.phase !== 'lobby' || A.G.conn) fail.push('un buscador se coló en la sala privada del amigo');
  if (!B.MM.on || B.MM.slot !== 0) fail.push('el buscador debía esperar en la cola (slot ' + B.MM.slot + ')');
  el(C, 'joinCode').value = 'zzzzzz'; C.api.joinRoom(); c.run(20000);
  if (C.G.phase !== 'lobby' || C.G.peer) fail.push('un código inexistente debía fallar limpio');
  el(C, 'joinCode').value = code.toLowerCase(); C.api.joinRoom(); c.run(5000);
  if (A.G.phase !== 'plan' || C.G.phase !== 'plan' || A.G.seed !== C.G.seed) fail.push('el amigo no pudo unirse con el código en minúsculas');
  if (B.G.phase !== 'lobby' || !B.MM.on) fail.push('el buscador no debía verse afectado por la partida privada');
  check('amigos: sala + código, unirse, código inexistente, y la búsqueda rápida convive sin colarse', fail.length === 0, fail.join('; '));
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

Promise.all(pending).then(() => {
  console.log(failed ? `\n${failed} test(s) fallaron` : '\nTodo OK');
  process.exit(failed ? 1 : 0);
});
