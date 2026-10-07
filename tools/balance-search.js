// Búsqueda local (1+λ) de constantes de balance (stats, costos y curva de fusión) con 4 procesos.
// Uso: node tools/balance-search.js [generaciones] [semilla]      (START=archivo.json para partir de un resultado previo)
// Minimiza una pérdida definida en evaluate(): triángulo por presupuesto, winrate por par de unidades y fusión.
// Es una ayuda para PROPONER constantes: validá siempre el resultado con otra semilla (tests/balance.js, --report)
// y, si cambia las reglas, subí SIM_VERSION y corré: node tests/run.js --update-fingerprint
const { fork } = require('child_process');
const path = require('path');
// Todas las unidades del juego; FOCUS=id1,id2 limita QUÉ unidades se mueven (y cuyas filas pesan en la pérdida):
// así se afinan unidades nuevas sin tocar las ya balanceadas. Sin FOCUS se mueven todas.
const IDS = Object.keys(require('../tests/load').loadGame(['UNITS']).api.UNITS);
const FOCUS = process.env.FOCUS ? process.env.FOCUS.split(',') : IDS;
const KNOBS = FOCUS.flatMap(id => ['hp','dmg','cost'].map(k => id + '.' + k)).concat(process.env.FOCUS ? [] : ['lvl2','lvl3']);

function applyVec(api, vec) {
  for (const id of IDS) { const u = api.UNITS[id];
    const cm = vec[id+'.cost']||1, hm = vec[id+'.hp']||1, dm = vec[id+'.dmg']||1;
    u.cost = Math.max(10, Math.round(u.cost*cm/5)*5); u.tech.cost = Math.max(10, Math.round(u.tech.cost*cm/10)*10);
    u.hp = Math.round(u.hp*hm); u.dmg = Math.max(1, Math.round(u.dmg*dm));
  }
}
function evaluate(vec, n, seedBase, lvl) {
  const { createBench } = require('../tests/balance');
  const B = createBench((api, ctx) => { applyVec(api, vec);
    const L2 = 1.9*(vec.lvl2||1), L3 = 2.8*(vec.lvl3||1);
    ctx.lvlMult = l => l<=1 ? 1 : l===2 ? L2 : L3 + (l-3)*(L3-L2); });
  const cl = (x) => Math.max(0, x);
  let loss = 0; const diag = { tri: {}, avg: {} };
  for (const b of [400, 800, 1500, 2500]) { diag.tri[b] = B.TRI.map(([a, c]) => B.typeDuel(a, c, b, n)); for (const w of diag.tri[b]) loss += 3*(cl(0.66-w)**2 + cl(w-0.88)**2); }
  const ids = IDS; const M = {};
  const win = (a, c) => { const w = B.unitDuel(a, c, 1000, n); return w; };
  for (const a of ids) M[a] = {};
  const fset = new Set(FOCUS);
  for (let i = 0; i < ids.length; i++) for (let j = i+1; j < ids.length; j++) { if (!fset.has(ids[i]) && !fset.has(ids[j])) continue; const w = win(ids[i], ids[j]); M[ids[i]][ids[j]] = w; M[ids[j]][ids[i]] = 1-w; }   // solo pares con una unidad en foco
  const T = id => B.api.UNITS[id].type;
  const range = (a, c) => { const ta=T(a), tc=T(c);
    const cnt = (x,y)=> (x==='swarm'&&y==='heavy')||(x==='heavy'&&y==='ranged')||(x==='ranged'&&y==='swarm');
    if (cnt(ta,tc)) return [0.62,0.90]; if (cnt(tc,ta)) return [0.10,0.38];
    if (ta==='assault'&&tc==='heavy') return [0.20,0.60]; if (tc==='assault'&&ta==='heavy') return [0.40,0.80];
    if (ta==='assault') return [0.40,0.80]; if (tc==='assault') return [0.20,0.60];
    return [0.25,0.75]; };
  for (const a of FOCUS) { let s = 0; for (const c of ids) if (a !== c) { const [lo,hi] = range(a,c); const w = M[a][c]; loss += 1.5*(cl(lo-w)**2 + cl(w-hi)**2); s += w; } diag.avg[a] = s/(ids.length-1); loss += 2*(cl(0.40-diag.avg[a])**2 + cl(diag.avg[a]-0.60)**2); }
  diag.fus = {};
  for (const id of FOCUS) { const r = B.fusionDuel(id, n); diag.fus[id] = r; loss += 1.5*(cl(0.40-r.L2)**2 + cl(r.L2-0.65)**2) + 1.5*(cl(0.40-r.L3)**2 + cl(r.L3-0.70)**2); }
  diag.M = M;
  let reg = 0; for (const k of KNOBS) reg += Math.log(vec[k]||1)**2; loss += 0.8*reg;
  return { loss, diag };
}
module.exports = { evaluate, applyVec, IDS, KNOBS };

if (process.argv[2] === 'worker') {
  process.on('message', m => { const r = evaluate(m.vec, m.n, m.seed); process.send({ id: m.id, ...r }); });
} else if (require.main === module) {
  const gens = +process.argv[2] || 10; let rs = +process.argv[3] || 1;
  const rnd = () => { rs = (rs*1664525 + 1013904223) >>> 0; return rs/4294967296; };
  const workers = Array.from({length:4}, () => fork(__filename, ['worker']));
  const pending = new Map(); let nid = 0;
  workers.forEach(w => w.on('message', r => { pending.get(r.id)(r); pending.delete(r.id); }));
  const run = (vec, i) => new Promise(res => { const id = nid++; pending.set(id, res); workers[i%4].send({ id, vec, n: 14 }); });
  (async () => {
    let best = process.env.START ? JSON.parse(require('fs').readFileSync(process.env.START)).best : {}; let bestR = await run(best, 0); console.log('base loss', bestR.loss.toFixed(3));
    for (let g = 0; g < gens; g++) {
      const cands = Array.from({length:8}, () => { const v = {...best}; const k = 1 + Math.floor(rnd()*3);
        for (let q = 0; q < k; q++) { const key = KNOBS[Math.floor(rnd()*KNOBS.length)]; v[key] = Math.min(4, Math.max(0.25, (v[key]||1) * Math.exp((rnd()-0.5)*0.4))); } return v; });
      const rs2 = await Promise.all(cands.map((v,i) => run(v,i)));
      let bi = -1; rs2.forEach((r,i) => { if (r.loss < bestR.loss - 1e-9 && (bi<0 || r.loss < rs2[bi].loss)) bi = i; });
      if (bi >= 0) { best = cands[bi]; bestR = rs2[bi]; }
      console.log('gen', g, 'loss', bestR.loss.toFixed(3), bi>=0?'*':'');
      require('fs').writeFileSync(require('path').join(require('os').tmpdir(), 'ironsiege-balance-best.json'), JSON.stringify({ best, loss: bestR.loss }));
    }
    console.log(JSON.stringify(best)); workers.forEach(w => w.kill());
  })();
}
