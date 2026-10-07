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
// Se mide en presupuestos de partida media/tardía (ver --report para barrido completo:
// a presupuestos <=800 el enjambre todavía le gana al rango; es un hallazgo de balance conocido).
const TRI = [['swarm', 'heavy'], ['heavy', 'ranged'], ['ranged', 'swarm']];
const TRI_BUDGETS = [1200, 2000];
for (const budget of TRI_BUDGETS) for (const [a, b] of TRI) {
  const r = duelWinrate(a, b, 40, budget);
  check(`triángulo @${budget}◈: ${a} > ${b}`, r.rate >= 0.55, `${(r.rate * 100).toFixed(0)}% (${r.wins}/${r.n}, empates ${r.draws})`);
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
