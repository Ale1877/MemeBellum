// Métricas de balance reutilizables (las usan tests/run.js --report y las herramientas de afinado).
// Todo el azar de los ejércitos de prueba sale de makeRNG con semilla fija: resultados reproducibles.
const { loadGame } = require('./load');

function createBench(mod) {
  const { api, ctx } = loadGame();
  if (mod) mod(api, ctx);
  const { simulate, UNITS, makeRNG } = api;
  const ids = () => Object.keys(UNITS);
  const idsOfType = t => Object.values(UNITS).filter(u => u.type === t).map(u => u.id);

  function buildArmy(rng, unitIds, budget, lvl = 1) {
    const deploy = []; let spent = 0, i = 0;
    while (true) {
      const u = UNITS[unitIds[i++ % unitIds.length]];
      if (spent + u.cost > budget) break;
      spent += u.cost;
      deploy.push({ id: u.id, lvl, x: 60 + rng() * 880, y: 246 + rng() * 176 });
    }
    return deploy;
  }
  // fracción de victorias (empate = 0.5) de A contra B; alterna lados host/guest
  function winrate(makeA, makeB, n = 40, seed = 1, techA = {}, techB = {}) {
    const rng = makeRNG(seed); let w = 0;
    for (let k = 0; k < n; k++) {
      const A = makeA(rng), B = makeB(rng);
      const aHost = k % 2 === 0;
      const r = aHost ? simulate(A, B, techA, techB, 1000 + k) : simulate(B, A, techB, techA, 1000 + k);
      const side = aHost ? 'host' : 'guest';
      w += r.winner === side ? 1 : r.winner === 'draw' ? 0.5 : 0;
    }
    return w / n;
  }
  const typeDuel = (a, b, budget, n = 40) => winrate(r => buildArmy(r, idsOfType(a), budget), r => buildArmy(r, idsOfType(b), budget), n);
  const unitDuel = (a, b, budget, n = 40) => winrate(r => buildArmy(r, [a], budget), r => buildArmy(r, [b], budget), n);
  // fusión: 1 unidad de nivel L contra (m) unidades de nivel L-1 con el mismo costo total
  function fusionDuel(id, n = 40) {
    const pos = r => ({ x: 200 + r() * 600, y: 260 + r() * 150 });
    const L2 = winrate(r => [{ id, lvl: 2, ...pos(r) }], r => [{ id, lvl: 1, ...pos(r) }, { id, lvl: 1, ...pos(r) }], n, 7);
    const L3 = winrate(r => [{ id, lvl: 3, ...pos(r) }], r => [{ id, lvl: 1, ...pos(r) }, { id, lvl: 1, ...pos(r) }, { id, lvl: 1, ...pos(r) }, { id, lvl: 1, ...pos(r) }], n, 8);
    return { L2, L3 };
  }
  const TRI = [['swarm', 'heavy'], ['heavy', 'ranged'], ['ranged', 'swarm']];
  return { api, ids, idsOfType, buildArmy, winrate, typeDuel, unitDuel, fusionDuel, TRI };
}

module.exports = { createBench };
