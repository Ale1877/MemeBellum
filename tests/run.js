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
  check('balance: fusión L2 vs 2×L1 no domina (≤ 82%)', worst[1] <= 0.82, `peor caso ${worst[0]} ${(worst[1] * 100).toFixed(0)}%`);
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
    if (p.host.G.baseMe !== p.guest.G.baseFoe || p.host.G.baseFoe !== p.guest.G.baseMe) fail.push('bases distintas entre host y guest');
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
    if (H.winsMe !== Gu.winsFoe || H.winsFoe !== Gu.winsMe || !H.matchEnded) fail.push(`B: marcadores ${H.winsMe}-${H.winsFoe} vs ${Gu.winsMe}-${Gu.winsFoe}`);
    if (H.baseMe !== Gu.baseFoe || H.baseFoe !== Gu.baseMe) fail.push(`B: bases distintas (${H.baseMe}/${H.baseFoe} vs ${Gu.baseMe}/${Gu.baseFoe})`);
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
  H.G.baseMe = 340; H.G.baseFoe = 0; Gu.G.baseMe = 0; Gu.G.baseFoe = 340; H.G.matchEnded = true; Gu.G.matchEnded = true;   // partida terminada: la base del guest cayó
  H.requestRematch(); p.pump(); run(500);
  if (H.G.phase !== 'over' || Gu.G.phase !== 'over') fail.push('arrancó con un solo jugador pidiendo la revancha');
  Gu.requestRematch(); p.pump(); run(1000);
  for (const [n, m] of [['host', H], ['guest', Gu]]) {
    const G = m.G;
    if (G.phase !== 'plan' || G.round !== 1 || G.winsMe !== 0 || G.winsFoe !== 0) fail.push(`${n}: no reinició (fase ${G.phase}, ronda ${G.round}, ${G.winsMe}-${G.winsFoe})`);
    if (G.income !== 200 || G.gold !== 200) fail.push(`${n}: economía heredada (ingreso ${G.income}, oro ${G.gold})`);
    if (G.baseMe !== 1000 || G.baseFoe !== 1000 || G.matchEnded) fail.push(`${n}: bases/estado de la partida anterior heredados (${G.baseMe}/${G.baseFoe})`);
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
    // un replay grabado con otras reglas avisa (en vez de mostrar otro resultado sin decirlo)
    const oldRec = JSON.parse(JSON.stringify(rh)); oldRec.sim = V.SIM_VERSION - 1;
    V.G.battleSpeed = 4; V.replayOpen(oldRec);
    if (!/otra versión/.test(v.hl.ctx.document.getElementById('toast').textContent)) fail.push('no avisó que el replay es de otra versión de las reglas');
    V.replayClose();
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

// (t) comprobación de versión: un rival con otra versión se rechaza ANTES de empezar (sala privada, búsqueda rápida)
{
  const { makePair, handshake, makeCrowd } = require('./net');
  const fail = [];
  const el = (m, id) => m.ctx.document.getElementById(id);
  const oldClient = (m) => { const real = m.ctx.send; m.ctx.send = (o) => real(o && o.t === 'hello' ? { t: 'hello', name: o.name } : o); };   // un build viejo: hello sin versiones
  const otherRules = (m) => { const real = m.ctx.send; m.ctx.send = (o) => real(o && o.t === 'hello' ? { ...o, sim: o.sim - 1 } : o); };      // mismo protocolo, otras reglas

  // 1. unitario: hello con versión distinta / sin versión -> se rechaza y no hay semilla; con versión correcta -> arranca
  for (const [label, hello] of [['sin versiones', { t: 'hello', name: 'X' }], ['otras reglas', { t: 'hello', name: 'X', sim: 1, net: 1 }], ['otro protocolo', { t: 'hello', name: 'X', sim: 2, net: 99 }]]) {
    const p = makePair(); p.host.G.phase = 'lobby'; p.host.G.isHost = true;
    p.host.onData(hello); p.pump();
    if (p.host.G.phase !== 'lobby' || p.host.G.conn !== null) fail.push(`1 (${label}): no se rechazó (fase ${p.host.G.phase})`);
    if (p.queue.length) fail.push(`1 (${label}): igual envió datos al rival`);
  }
  { const p = makePair(); handshake(p); if (p.host.G.phase !== 'plan' || p.guest.G.phase !== 'plan') fail.push('1: con versiones correctas debía arrancar'); }

  // 2. sala privada: un invitado con build viejo falla con un mensaje claro y la sala sigue abierta para otro amigo
  { const c = makeCrowd(3); const [A, C, D] = c.ms;
    A.api.hostCreate(); c.run(500); const code = el(A, 'roomCode').textContent;
    oldClient(C); el(C, 'joinCode').value = code; C.api.joinRoom(); c.run(8000);
    if (C.G.phase !== 'lobby' || !/versión/.test(el(C, 'joinStatus').textContent) || !/Recargá/.test(el(C, 'joinStatus').textContent)) fail.push('2: el invitado viejo no vio el mensaje de versión: ' + el(C, 'joinStatus').textContent);
    if (A.G.phase !== 'lobby' || !A.G.peer || A.G.conn) fail.push('2: la sala del anfitrión debía seguir abierta y libre');
    el(D, 'joinCode').value = code; D.api.joinRoom(); c.run(8000);
    if (A.G.phase !== 'plan' || D.G.phase !== 'plan' || A.G.seed !== D.G.seed) fail.push('2: un amigo compatible no pudo entrar después del rechazo'); }
  // 3. el anfitrión es el viejo: el invitado nuevo lo rechaza
  { const c = makeCrowd(2); const [H, G2] = c.ms;
    oldClient(H); H.api.hostCreate(); c.run(500); el(G2, 'joinCode').value = el(H, 'roomCode').textContent; G2.api.joinRoom(); c.run(8000);
    if (G2.G.phase !== 'lobby' || H.G.phase !== 'lobby') fail.push(`3: no debía arrancar con un anfitrión viejo (${H.G.phase}/${G2.G.phase})`);
    if (!/versión/.test(el(G2, 'joinStatus').textContent)) fail.push('3: el invitado nuevo no explicó el motivo'); }
  // 4. otras reglas (mismo protocolo) también se rechazan
  { const c = makeCrowd(2); const [H, G2] = c.ms; otherRules(G2);
    H.api.hostCreate(); c.run(500); el(G2, 'joinCode').value = el(H, 'roomCode').textContent; G2.api.joinRoom(); c.run(8000);
    if (G2.G.phase !== 'lobby' || H.G.phase !== 'lobby') fail.push('4: arrancó con reglas distintas'); }
  // 5. búsqueda rápida: un buscador viejo no se empareja con uno nuevo, y el nuevo sí encuentra a otro nuevo
  { const c = makeCrowd(2); const [A, B] = c.ms; oldClient(B);
    A.api.mmStart(); B.api.mmStart(); c.run(40000);
    if (A.G.phase === 'plan' || B.G.phase === 'plan') fail.push('5: un buscador viejo y uno nuevo no debían emparejarse');
    const C = c.add('Nuevo'); C.api.mmStart(); c.run(150000);
    if (A.G.phase !== 'plan' || C.G.phase !== 'plan' || A.G.seed !== C.G.seed) fail.push(`5: los dos buscadores nuevos no se encontraron (${A.G.phase}/${C.G.phase})`);
    if (B.G.phase !== 'lobby') fail.push('5: el buscador viejo no debía entrar en partida'); }
  check('versión: rechaza clientes con otra versión antes de empezar (sala privada y búsqueda) y no bloquea a los compatibles', fail.length === 0, fail.join('; '));
}

// (u) respawn estilo Mechabellum: las unidades destruidas vuelven a pleno HP en la ronda siguiente; los supervivientes conservan el daño
{
  const { makePair, handshake } = require('./net');
  const fail = [];
  const mk = (ids, y) => ids.map((id, i) => ({ id, lvl: 1, x: 150 + i * 120, y: y + (i % 3) * 15 }));

  // A. la simulación informa 'rev': destruidas = HP máximo, supervivientes = su HP; nunca peor que estar destruido
  { const p = makePair(); const m = p.host;
    for (let k = 0; k < 20; k++) {
      const H = mk(['crawler', 'warden', 'longbow', 'vulcan', 'marauder', 'titan'].slice(0, 2 + k % 5), 390), Gd = mk(['titan', 'crawler', 'vulcan', 'warden'].slice(0, 2 + k % 3), 390);
      const r = m.simulate(H, Gd, {}, {}, 300 + k);
      for (const surv of [r.hostSurv, r.guestSurv]) for (const [di, s] of Object.entries(surv)) {
        if (!(s.rev >= s.hp - 1e-6 && s.rev <= s.max + 1e-6)) fail.push(`A${k}: rev fuera de rango (${s.rev} / ${s.hp}..${s.max})`);
        if (s.hp <= 0 && Math.abs(s.rev - s.max) > 1e-6) fail.push(`A${k}: una unidad destruida no reaparece a pleno HP`);
      }
    } }

  // B. partida real: tras una ronda con bajas el ejército NO se achica y se puede confirmar sin comprar nada
  { const p = makePair({ raf: true }); handshake(p);
    const H = p.host, Gu = p.guest;
    const run = (ms) => { for (let t = 0; t < ms; t += 250) { p.clock.advance(250); p.pump(); } };
    H.G.battleSpeed = 4; Gu.G.battleSpeed = 4;
    H.G.myDeploy.push(...mk(['crawler', 'crawler', 'marauder', 'warden'], 400));
    Gu.G.myDeploy.push(...mk(['titan', 'vulcan', 'longbow'], 380));
    const n0 = [H.G.myDeploy.length, Gu.G.myDeploy.length];
    H.confirmReady(); p.pump(); Gu.confirmReady(); p.pump();
    let g = 0; while (H.G.phase !== 'plan' && H.G.phase !== 'over' && g++ < 400) run(500);
    run(2000);
    if (H.G.round !== 2 || Gu.G.round !== 2) fail.push('B: no pasó a la ronda 2');
    if (H.G.myDeploy.length !== n0[0] || Gu.G.myDeploy.length !== n0[1]) fail.push(`B: el ejército se achicó (${n0} -> ${H.G.myDeploy.length},${Gu.G.myDeploy.length}): las destruidas no reaparecieron`);
    const log0 = p.log.host[0];
    if (log0.winner === 'draw') fail.push('B: la ronda 1 debía tener un ganador');
    // reglas Mechabellum: TODO el ejército vuelve a pleno HP (destruidas y supervivientes), sin daño arrastrado
    if (H.PERSIST_DAMAGE !== false) fail.push('B: PERSIST_DAMAGE debe ser false (todo el ejército se restaura)');
    for (const [n, m] of [['host', H], ['guest', Gu]]) {
      for (const d of m.G.myDeploy) if (d.dmgFrac !== undefined) fail.push(`B: ${n} arrastra daño (${d.dmgFrac}): debía volver a pleno HP`);
      const ents = m.expand(m.G.myDeploy, 'host', {});
      if (ents.some(e => e.hp !== e.maxhp)) fail.push(`B: ${n} tiene unidades que no empiezan la ronda a pleno HP`);
    }
    if (p.log.host[0].hostHP >= 0 && Math.min(p.log.host[0].hostHP, p.log.host[0].guestHP) > 0) fail.push('B: la ronda 1 debía dejar un bando sin HP (para probar que el ganador también se restaura)');
    // ronda 2 sin comprar nada: se puede confirmar y ambas máquinas simulan lo mismo
    H.confirmReady(); p.pump(); Gu.confirmReady(); p.pump();
    if (H.G.phase !== 'battle' || Gu.G.phase !== 'battle') fail.push('B: no se pudo jugar la ronda 2 con las unidades que reaparecieron');
    g = 0; while (H.G.phase === 'battle' && g++ < 400) run(500);
    if (p.log.host.length !== 2 || JSON.stringify(p.log.host) !== JSON.stringify(p.log.guest)) fail.push('B: las simulaciones de la ronda 2 difieren entre máquinas');
    // lo grabado en el replay coincide en ambos lados (incluye los dmgFrac arrastrados)
    if (JSON.stringify(H.Rec.cur.rounds) !== JSON.stringify(Gu.Rec.cur.rounds)) fail.push('B: el replay grabó entradas distintas en host y guest'); }

  check('respawn estilo Mechabellum: todo el ejército (destruidas y supervivientes) vuelve a pleno HP, intacto y con la misma simulación', fail.length === 0, fail.slice(0, 4).join('; '));
}

// (v) vida de base: daño al perdedor según las unidades que le quedan al ganador; gana quien destruye la base rival
{
  const { makePair, handshake } = require('./net');
  const fail = [];
  const p = makePair({ raf: true }); handshake(p);
  const H = p.host, Gu = p.guest;
  // A. fórmula exacta: 20 + 0.30 * (costo por miembro * 2^(nivel-1)) de cada superviviente del ganador
  const one = (id, lvl) => H.simulate([{ id, lvl, x: 500, y: 400 }], [], {}, {}, 1);
  const val = (id, lvl, n) => Math.round(20 + 0.30 * (H.UNITS[id].cost / H.UNITS[id].count) * n * Math.pow(2, lvl - 1));
  for (const [id, lvl] of [['warden', 1], ['warden', 2], ['titan', 1], ['crawler', 1], ['mortar', 1]]) {
    const r = one(id, lvl), want = val(id, lvl, H.UNITS[id].count);
    if (r.winner !== 'host' || r.baseDmg.guest !== want || r.baseDmg.host !== 0) fail.push(`A: ${id} L${lvl}: daño ${JSON.stringify(r.baseDmg)} (esperado ${want} al guest)`);
  }
  const d = H.simulate([], [], {}, {}, 1); if (d.winner !== 'draw' || d.baseDmg.host !== 0 || d.baseDmg.guest !== 0) fail.push('A: un empate no debe hacer daño: ' + JSON.stringify(d.baseDmg));
  const g = H.simulate([], [{ id: 'warden', lvl: 1, x: 500, y: 400 }], {}, {}, 1); if (g.baseDmg.host !== val('warden', 1, 1) || g.baseDmg.guest !== 0) fail.push('A: si gana el guest el daño es al host: ' + JSON.stringify(g.baseDmg));
  // B. matchOutcome: base a 0, límite de rondas por mayor base, empate
  const mo = (b1, b2, r) => { H.G.baseMe = b1; H.G.baseFoe = b2; H.G.round = r; return H.matchOutcome(); };
  if (mo(500, 0, 3) !== 'me' || mo(0, 500, 3) !== 'foe' || mo(0, 0, 3) !== 'draw' || mo(500, 400, 3) !== null) fail.push('B: matchOutcome por base destruida');
  if (mo(700, 400, 12) !== 'me' || mo(300, 400, 12) !== 'foe' || mo(400, 400, 12) !== 'draw' || mo(700, 400, 11) !== null) fail.push('B: matchOutcome por límite de rondas');
  H.G.baseMe = 1000; H.G.baseFoe = 1000; H.G.round = 1;

  // C. partida real desigual: el host aplasta al guest; termina cuando la base del guest llega a 0, antes del límite de rondas
  const q = makePair({ raf: true }); handshake(q);
  const QH = q.host, QG = q.guest;
  const run = (ms) => { for (let t = 0; t < ms; t += 250) { q.clock.advance(250); q.pump(); } };
  QH.G.battleSpeed = 4; QG.G.battleSpeed = 4;
  QH.G.myDeploy.push({ id: 'titan', lvl: 2, x: 300, y: 400 }, { id: 'titan', lvl: 1, x: 600, y: 400 }, { id: 'warden', lvl: 1, x: 450, y: 410 });
  QG.G.myDeploy.push({ id: 'crawler', lvl: 1, x: 300, y: 400 }, { id: 'wasp', lvl: 1, x: 500, y: 400 });
  const trail = []; let g2 = 0, rounds = 0;
  while (QH.G.phase !== 'over' && g2++ < 600) {
    for (const m of [QH, QG]) if (m.G.phase === 'plan' && !m.G.myReady) m.confirmReady();
    run(500);
    if (QH.G.phase === 'plan' && QH.G.round !== rounds) { rounds = QH.G.round; trail.push([QH.G.baseMe, QH.G.baseFoe]); }
  }
  const HG = QH.G, GG = QG.G;
  if (HG.phase !== 'over' || GG.phase !== 'over' || !HG.matchEnded || !GG.matchEnded) fail.push(`C: la partida no terminó (${HG.phase}/${GG.phase})`);
  if (HG.baseFoe !== 0 || HG.baseMe !== 1000) fail.push(`C: bases finales ${HG.baseMe}/${HG.baseFoe} (esperado 1000/0)`);
  if (HG.baseMe !== GG.baseFoe || HG.baseFoe !== GG.baseMe) fail.push('C: host y guest ven bases distintas');
  if (HG.round >= 12) fail.push('C: debía terminar por base destruida antes del límite de rondas (ronda ' + HG.round + ')');
  for (let i = 1; i < trail.length; i++) if (trail[i][1] > trail[i - 1][1]) fail.push('C: la base del perdedor subió entre rondas');
  // el replay graba el daño a las bases y la suma coincide con el estado final
  const rec = QH.Rec.cur, dmgSum = rec.rounds.reduce((a, r) => [a[0] + r.bd[0], a[1] + r.bd[1]], [0, 0]);
  if (Math.max(0, 1000 - dmgSum[1]) !== HG.baseFoe || Math.max(0, 1000 - dmgSum[0]) !== HG.baseMe) fail.push(`C: el replay no suma el mismo daño (${dmgSum} vs bases ${HG.baseMe}/${HG.baseFoe})`);
  const clean = QH.sanitizeReplay(JSON.parse(JSON.stringify(rec)));
  if (!clean || JSON.stringify(clean.rounds.map(r => r.bd)) !== JSON.stringify(rec.rounds.map(r => r.bd))) fail.push('C: sanitizeReplay alteró el daño a las bases');
  // se puede pedir revancha tras destruir una base, pero no antes
  if (!(QH.G.matchEnded)) fail.push('C: matchEnded sin marcar');
  check('base: fórmula de daño, empate, límite de rondas, partida hasta destruir la base y replay con daño', fail.length === 0, fail.join('; '));
}

// (w) desbloqueo de unidades: ofertas deterministas verificables por ambos lados, flujo real y tramposos
{
  const { makePair, handshake } = require('./net');
  const fail = [];
  const mkPair = () => { const p = makePair({ raf: true }); handshake(p, { keepLocks: true }); p.host.G.battleSpeed = 4; p.guest.G.battleSpeed = 4; return p; };
  const runFor = (p, ms) => { for (let t = 0; t < ms; t += 250) { p.clock.advance(250); p.pump(); } };
  const starters = [...mkPair().host.STARTERS].sort().join();
  const toRound2 = (p) => {                              // juega la ronda 1 con unidades iniciales
    for (const m of [p.host, p.guest]) { m.G.myDeploy.push({ id: 'warden', lvl: 1, x: 300, y: 400 }, { id: 'crawler', lvl: 1, x: 500, y: 410 }); m.confirmReady(); }
    p.pump(); let g = 0; while (!(p.host.G.phase === 'plan' && p.host.G.round === 2) && g++ < 400) runFor(p, 500);
    runFor(p, 500);
  };

  // A. arranque: solo las iniciales, igual en ambas máquinas; ronda 1 sin oferta
  { const p = mkPair(); const H = p.host, Gu = p.guest;
    for (const [n, set] of [['host.unlocked', H.G.unlocked], ['host.foeUnlocked', H.G.foeUnlocked], ['guest.unlocked', Gu.G.unlocked], ['guest.foeUnlocked', Gu.G.foeUnlocked]]) if ([...set].sort().join() !== starters) fail.push(`A: ${n} no empieza con las iniciales`);
    if (H.G.offer.length || Gu.G.offer.length) fail.push('A: la ronda 1 no debe tener oferta');
    // B. la oferta: tamaño, distintas, bloqueadas, y el host calcula igual que el guest para el guest (y al revés)
    for (let r = 2; r <= 6; r++) for (const side of ['host', 'guest']) {
      const mine = side === 'host' ? H : Gu, other = side === 'host' ? Gu : H;
      const a = mine.unlockOffer(side, r, mine.G.unlocked), b = other.unlockOffer(side, r, other.G.foeUnlocked);
      if (JSON.stringify(a) !== JSON.stringify(b)) fail.push(`B: ronda ${r} ${side}: las dos máquinas calculan ofertas distintas`);
      if (a.length !== 3 || new Set(a).size !== 3 || a.some(id => mine.G.unlocked.has(id) || !mine.UNITS[id])) fail.push(`B: oferta inválida ${JSON.stringify(a)}`);
    }
    const all = Object.keys(H.UNITS);
    if (H.unlockOffer('host', 1, H.G.unlocked).length) fail.push('B: la ronda 1 debía dar [] ');
    if (H.unlockOffer('host', 3, new Set(all.slice(0, all.length - 2))).length !== 2) fail.push('B: con 2 bloqueadas debía ofrecer 2');
    if (H.unlockOffer('host', 3, new Set(all)).length !== 0) fail.push('B: sin bloqueadas no hay oferta');
    if (JSON.stringify(H.unlockOffer('host', 2, H.G.unlocked)) === JSON.stringify(H.unlockOffer('guest', 2, H.G.unlocked)) && JSON.stringify(H.unlockOffer('host', 3, H.G.unlocked)) === JSON.stringify(H.unlockOffer('guest', 3, H.G.unlocked))) fail.push('B: host y guest reciben siempre la misma oferta (debería variar)'); }

  // C. flujo real: ronda 2 con oferta; confirmar sin elegir avisa; elegir; desplegar lo desbloqueado; el rival lo valida
  { const p = mkPair(); const H = p.host, Gu = p.guest; toRound2(p);
    if (H.G.round !== 2 || H.G.offer.length !== 3 || Gu.G.offer.length !== 3) fail.push(`C: sin oferta en la ronda 2 (${H.G.offer.length}/${Gu.G.offer.length}, ronda ${H.G.round})`);
    const hOffer = [...H.G.offer], gOffer = [...Gu.G.offer];
    H.confirmReady(); if (H.G.myReady) fail.push('C: confirmó sin elegir desbloqueo a la primera');
    Gu.pickUnlock(gOffer[2]); if (!Gu.G.unlocked.has(gOffer[2]) || Gu.G.unlockPicked !== gOffer[2]) fail.push('C: pickUnlock no desbloqueó');
    if (Gu.pickUnlock(gOffer[0])) fail.push('C: se pudo elegir dos veces');
    H.confirmReady();                                    // segunda confirmación: toma la primera de la oferta
    if (H.G.unlockPicked !== hOffer[0]) fail.push('C: la elección automática debía ser la primera de la oferta');
    H.G.myDeploy.length; Gu.G.myDeploy.push({ id: gOffer[2], lvl: 1, x: 700, y: 400 });   // despliega lo recién desbloqueado
    Gu.confirmReady(); p.pump();
    if (!H.G.foeReady || !H.G.foeUnlocked.has(gOffer[2])) fail.push('C: el host no aceptó el desbloqueo/despliegue del guest');
    if (!Gu.G.foeUnlocked.has(hOffer[0])) fail.push('C: el guest no registró el desbloqueo del host');
    let g = 0; while (H.G.phase === 'battle' && g++ < 400) runFor(p, 500);
    if (p.log.host.length !== 2 || JSON.stringify(p.log.host) !== JSON.stringify(p.log.guest)) fail.push('C: simulaciones distintas tras desbloquear');
    if (H.G.unlocked.size !== 5 || H.G.foeUnlocked.size !== 5 || Gu.G.unlocked.size !== 5) fail.push('C: tamaños de desbloqueo inesperados'); }

  // D. tramposos: el rival rechaza lo que un cliente modificado enviaría
  { const p = mkPair(); const H = p.host; toRound2(p);
    const offer = H.unlockOffer('guest', 2, H.G.foeUnlocked), notOffered = Object.keys(H.UNITS).find(id => !H.G.foeUnlocked.has(id) && !offer.includes(id));
    const base = { t: 'ready', round: 2, deploy: [{ id: 'warden', lvl: 1, x: 400, y: 400 }], tech: {} };
    const tries = [['unlock fuera de la oferta', { ...base, unlock: notOffered }], ['sin unlock habiendo oferta', { ...base }], ['unlock de algo no ofrecido y numérico', { ...base, unlock: 7 }],
      ['desplegar una bloqueada', { ...base, unlock: offer[0], deploy: [{ id: notOffered, lvl: 1, x: 400, y: 400 }] }]];
    for (const [label, m] of tries) { const before = H.G.foeUnlocked.size; H.G.foeReady = false; H.onData(m); if (H.G.foeReady || H.G.foeUnlocked.size !== before) fail.push(`D: aceptó "${label}"`); }
    H.G.foeReady = false; H.onData({ ...base, unlock: offer[1] });
    if (!H.G.foeReady || !H.G.foeUnlocked.has(offer[1])) fail.push('D: no aceptó un desbloqueo legítimo');
    const q = mkPair(); q.host.onData({ t: 'ready', round: 1, deploy: [{ id: 'warden', lvl: 1, x: 400, y: 400 }], tech: {}, unlock: 'titan' });
    if (q.host.G.foeReady) fail.push('D: aceptó un desbloqueo en la ronda 1 (no hay oferta)');
    const w = mkPair(); w.host.onData({ t: 'ready', round: 1, deploy: [{ id: 'titan', lvl: 1, x: 400, y: 400 }], tech: {}, unlock: null });
    if (w.host.G.foeReady) fail.push('D: aceptó desplegar un Titan sin tenerlo desbloqueado');
    const x = mkPair(); x.host.onData({ t: 'ready', round: 1, deploy: [{ id: 'warden', lvl: 1, x: 400, y: 400 }], tech: { titan: true, warden: true }, unlock: null });
    if (!x.host.G.foeReady || x.host.G.foeTech.titan || !x.host.G.foeTech.warden) fail.push('D: debía descartar la tecnología de una unidad no desbloqueada y conservar la legítima'); }

  // E. al vencer el tiempo se elige la primera oferta y todo sigue
  { const p = mkPair(); const H = p.host, Gu = p.guest; toRound2(p);
    const ho = H.G.offer[0], go = Gu.G.offer[0];
    runFor(p, 70000);
    if (!H.G.foeUnlocked.has(go) || !Gu.G.foeUnlocked.has(ho)) fail.push('E: el temporizador no eligió la primera oferta en alguna máquina');
    if (p.log.host.length < 2 || JSON.stringify(p.log.host) !== JSON.stringify(p.log.guest)) fail.push('E: simulaciones distintas tras la elección automática'); }

  // F. una partida nueva (revancha) vuelve a las iniciales
  { const p = mkPair(); const H = p.host; H.G.unlocked = new Set(Object.keys(H.UNITS)); H.startMatch();
    if ([...H.G.unlocked].sort().join() !== starters || H.G.offer.length) fail.push('F: startMatch no reinició los desbloqueos'); }
  check('desbloqueos: ofertas idénticas en ambas máquinas, flujo, tramposos y elección automática', fail.length === 0, fail.slice(0, 4).join('; '));
}

// (x) bot de práctica: juega con las mismas reglas (legal, determinista), termina partidas completas y funciona dentro del juego
{
  const { makeCrowd } = require('./net');
  const fail = [];
  const { api, playMatch } = require('../tools/match-sim');

  // A. legalidad: nunca gasta de más, solo despliega/investiga lo desbloqueado y elige dentro de su oferta
  { const { G } = api;
    for (let seed = 1; seed <= 25; seed++) for (const side of ['host', 'guest']) {
      G.seed = seed * 7919; const bs = api.botNew(); let earned = 0, last = null;
      for (let round = 1; round <= 10; round++) {
        const income = 200 + 80 * (round - 1); earned += income;
        const offer = api.unlockOffer(side, round, bs.unlocked);
        bs.intel = last; const m = api.botTurn(bs, round, income, G.seed, side); last = m.deploy;
        if (offer.length ? !offer.includes(m.unlock) : m.unlock !== null) fail.push(`A${seed}/${side}/r${round}: desbloqueo fuera de oferta (${m.unlock})`);
        const spent = m.deploy.reduce((s, d) => s + api.UNITS[d.id].cost, 0) + Object.keys(m.tech).reduce((s, id) => s + api.UNITS[id].tech.cost, 0);
        if (spent > earned || bs.gold < 0) fail.push(`A${seed}/${side}/r${round}: gastó ${spent} de ${earned} (oro ${bs.gold})`);
        if (m.deploy.some(d => !bs.unlocked.has(d.id)) || Object.keys(m.tech).some(id => !bs.unlocked.has(id))) fail.push(`A${seed}/${side}/r${round}: usó algo bloqueado`);
        if (m.deploy.some(d => !(d.x >= 0 && d.x <= 1000 && d.y >= 220 && d.y <= 440))) fail.push(`A${seed}/${side}/r${round}: posición fuera de su mitad`);
        if (m.deploy.length > 60) fail.push(`A${seed}/${side}/r${round}: ejército de ${m.deploy.length} unidades (tope 60)`);
        if (fail.length > 6) break;
      } if (fail.length > 6) break; } }
  // B. determinismo: mismas entradas, mismo mensaje
  { const { G } = api; G.seed = 4242; const a = api.botNew(), b = api.botNew(); let same = true;
    for (let r = 1; r <= 6; r++) { const x = JSON.stringify(api.botTurn(a, r, 200 + 80 * (r - 1), 4242, 'guest')), y = JSON.stringify(api.botTurn(b, r, 200 + 80 * (r - 1), 4242, 'guest')); if (x !== y) same = false; }
    if (!same) fail.push('B: el bot no es determinista con las mismas entradas'); }
  // C. partidas completas bot vs bot con las reglas reales: terminan, con ganador y dentro del límite
  for (const seed of [11, 22, 33, 44]) { const r = playMatch(seed * 1013);
    if (!['host', 'guest', 'draw'].includes(r.outcome) || r.rounds.length < 3 || r.rounds.length > 12) fail.push(`C${seed}: partida rara (${r.outcome}, ${r.rounds.length} rondas)`);
    if (r.outcome === 'host' && r.base.guest > 0 && !r.endedByLimit) fail.push(`C${seed}: ganó el host sin destruir la base ni agotar rondas`); }

  // D. dentro del juego: partida real contra el bot hasta el final, revancha y salida
  { const c = makeCrowd(1); const M = c.ms[0]; const G = M.G; const el = (id) => M.ctx.document.getElementById(id);
    el('playerName').value = 'Ale'; M.api.startBotMatch(); c.run(200);
    if (G.phase !== 'plan' || G.foeName !== 'BOT' || !G.bot || !G.isHost) fail.push(`D: no arrancó la partida vs bot (${G.phase}, ${G.foeName})`);
    if (!G.foeReady) fail.push('D: el bot debía tener su despliegue listo al empezar la ronda');
    if (G.foeDeploy && G.foeDeploy.some(d => !G.foeUnlocked.has(d.id))) fail.push('D: el bot desplegó algo bloqueado');
    G.battleSpeed = 4;
    c.run(100000);                                        // sin tráfico: no debe haber "rival desconectado" (no hay latidos)
    if (G.reconnecting || G.phase === 'over' && !G.matchEnded) fail.push('D: el bot provocó una desconexión falsa');
    let g = 0, guard = 0;
    while (G.phase !== 'over' && g++ < 400) {
      if (G.phase === 'plan' && !G.myReady) { if (G.myDeploy.length < 3) G.myDeploy.push({ id: 'warden', lvl: 1, x: 300 + g * 7 % 300, y: 400 }, { id: 'crawler', lvl: 1, x: 600, y: 410 }); M.api.confirmReady(true); }
      c.run(500);
    }
    if (G.phase !== 'over' || !G.matchEnded) fail.push(`D: la partida vs bot no terminó (${G.phase}, ronda ${G.round})`);
    if (G.baseMe > 0 && G.baseFoe > 0 && G.round < 12) fail.push('D: terminó sin base destruida ni límite de rondas');
    if (G.round > 12) fail.push('D: pasó el límite de rondas');
    if (!G.foeUnlocked || G.foeUnlocked.size < 5) fail.push('D: el bot no desbloqueó unidades durante la partida (' + G.foeUnlocked.size + ')');
    // revancha inmediata con el bot: estado limpio y vuelve a jugar
    M.api.requestRematch(); c.run(300);
    if (G.phase !== 'plan' || G.round !== 1 || G.baseMe !== 1000 || G.baseFoe !== 1000 || G.matchEnded || G.foeUnlocked.size !== 4 || !G.bot || G.bot.unlocked.size !== 4) fail.push(`D: la revancha vs bot no reinició (${G.phase}, r${G.round}, ${G.baseMe}/${G.baseFoe}, bot ${G.bot && G.bot.unlocked.size})`);
    if (!G.foeReady) fail.push('D: tras la revancha el bot debía tener su despliegue listo');
    M.api.leaveToLobby(); if (G.bot || G.phase !== 'lobby') fail.push('D: salir al lobby no limpió el bot'); }
  check('bot: legal, determinista, partidas completas bot-vs-bot y flujo real (revancha, sin falsas desconexiones)', fail.length === 0, fail.slice(0, 4).join('; '));
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
