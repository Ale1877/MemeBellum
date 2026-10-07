// Simulador de partidas completas SIN pantalla: dos bots (los mismos del juego) juegan con las reglas reales
// (desbloqueos, ejército restaurado cada ronda, daño a la base). Sirve para medir el ritmo de las partidas.
// Uso: node tools/match-sim.js [partidas=60] [semilla=1] [--json]
const { loadGame } = require('../tests/load');
const { api } = loadGame(['G', 'simulate', 'UNITS', 'makeRNG', 'botNew', 'botTurn', 'unlockOffer', 'STARTERS', 'BASE_HP', 'MAX_ROUNDS', 'INCOME_START']);

function playMatch(seed) {
  const { G } = api; G.seed = seed >>> 0;
  const bots = { host: api.botNew(), guest: api.botNew() };
  const base = { host: api.BASE_HP, guest: api.BASE_HP };
  const last = { host: null, guest: null };          // intel: each bot sees the other's previous army
  const rounds = [];
  let outcome = null;
  for (let round = 1; round <= api.MAX_ROUNDS && !outcome; round++) {
    const income = api.INCOME_START + 80 * (round - 1);
    bots.host.intel = last.guest; bots.guest.intel = last.host;
    const hm = api.botTurn(bots.host, round, income, G.seed, 'host'), gm = api.botTurn(bots.guest, round, income, G.seed, 'guest');
    last.host = hm.deploy; last.guest = gm.deploy;
    const r = api.simulate(hm.deploy, gm.deploy, hm.tech, gm.tech, G.seed + round * 7919);
    base.host = Math.max(0, base.host - r.baseDmg.host); base.guest = Math.max(0, base.guest - r.baseDmg.guest);
    rounds.push({ winner: r.winner, dmg: Math.max(r.baseDmg.host, r.baseDmg.guest), units: [hm.deploy.length, gm.deploy.length], ticks: r.frames.length * 2 });
    if (base.host <= 0 && base.guest <= 0) outcome = 'draw';
    else if (base.guest <= 0) outcome = 'host'; else if (base.host <= 0) outcome = 'guest';
    else if (round >= api.MAX_ROUNDS) outcome = base.host > base.guest ? 'host' : base.guest > base.host ? 'guest' : 'draw';
  }
  return { outcome, rounds, base, unlocked: [bots.host.unlocked.size, bots.guest.unlocked.size], endedByLimit: rounds.length >= api.MAX_ROUNDS && base.host > 0 && base.guest > 0 };
}

if (require.main === module) {
  const n = +process.argv[2] || 60, seed0 = +process.argv[3] || 1, t0 = Date.now();
  const res = []; for (let i = 0; i < n; i++) res.push(playMatch(seed0 * 100003 + i * 7919));
  const len = res.map(r => r.rounds.length), avg = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const hist = {}; for (const l of len) hist[l] = (hist[l] || 0) + 1;
  const dmgAll = res.flatMap(r => r.rounds.filter(x => x.winner !== 'draw').map(x => x.dmg));
  const draws = res.flatMap(r => r.rounds).filter(x => x.winner === 'draw').length, total = res.reduce((s, r) => s + r.rounds.length, 0);
  const win = k => res.filter(r => r.outcome === k).length;
  const out = { partidas: n, rondasPromedio: +avg(len).toFixed(2), rondasMin: Math.min(...len), rondasMax: Math.max(...len), histograma: hist,
    ganaHost: win('host'), ganaGuest: win('guest'), empates: win('draw'), terminoPorLimiteDeRondas: res.filter(r => r.endedByLimit).length,
    danioPorRondaPromedio: Math.round(avg(dmgAll)), rondasEmpatadas: draws + '/' + total,
    desbloqueadasAlFinal: +avg(res.map(r => avg(r.unlocked))).toFixed(1), unidadesPorEjercitoUltimaRonda: +avg(res.map(r => avg(r.rounds[r.rounds.length - 1].units))).toFixed(1),
    segundos: +((Date.now() - t0) / 1000).toFixed(1) };
  if (process.argv.includes('--json')) console.log(JSON.stringify(out)); else for (const k in out) console.log(k.padEnd(32), typeof out[k] === 'object' ? JSON.stringify(out[k]) : out[k]);
}
module.exports = { playMatch, api };
