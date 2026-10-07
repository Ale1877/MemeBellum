// Medición de rendimiento de dibujo en Chromium (render por software: los números absolutos son
// pesimistas, sirven para comparar antes/después).  NODE_PATH=$(npm root -g) node tests/perf.js [etiqueta]
const { chromium } = require('playwright');
const path = require('path');
const URL = 'file://' + (process.env.HTML || path.join(__dirname, '..', 'index.html'));
const tag = process.argv[2] || 'run';
const CASES = [
  ['desktop 1280x800 dpr1', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }],
  ['phone 390x844 dpr3', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }],
];
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  for (const [name, opts] of CASES) {
    const ctx = await b.newContext(opts); const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message));
    await pg.route('**/*', r => /^(file|about|data):/.test(r.request().url()) ? r.continue() : r.abort());
    await pg.goto(URL);
    const r = await pg.evaluate(async (fx) => {
      if (fx) setFx(fx, false);
      G.name = 'A'; G.foeName = 'B'; G.isHost = true; G.mySeedPart = 1; G.foeSeedPart = 2; startMatch(); G.gold = 9999;
      const mk = (ids, y0) => ids.flatMap((id, i) => Array.from({ length: 6 }, (_, k) => ({ id, lvl: 1, x: 80 + ((i * 6 + k) * 83) % 840, y: y0 + ((i * 37 + k * 53) % 150) })));
      G.myDeploy = mk(['crawler', 'marauder', 'warden', 'longbow', 'vulcan', 'titan'], 250);
      G.foeDeploy = mk(['titan', 'vulcan', 'crawler', 'warden', 'marauder', 'longbow'], 250);
      G.foeReady = true; G.battleSpeed = 4; G.myTech = { crawler: true, longbow: true };
      const times = []; window.__times = times;
      const t0 = performance.now();
      const wrap = (fn) => function (...a) { const st = performance.now(); const r = fn.apply(this, a); ctx.getImageData(0, 0, 1, 1); /* fuerza el raster para medir el costo real */ times.push(performance.now() - st); return r; };
      // versión nueva: el costo está en el loop de rAF; versión vieja: en drawField por frame de simulación
      if (typeof renderLoop === 'function') renderLoop = wrap(renderLoop); else { const o = drawField; drawField = function (...a) { if (!a[0]) return o.apply(this, a); return wrap(o).apply(this, a); }; }
      confirmReady();
      await new Promise(res => { const iv = setInterval(() => { if (G.phase !== 'battle') { clearInterval(iv); res(); } }, 50); });
      return { n: times.length, total: performance.now() - t0, times };
    }, process.env.FX || '');
    const t = r.times;
    console.log(`${tag} | ${name} | frames ${r.n} | ${(r.total / 1000).toFixed(1)}s | busy ${(t.reduce((s, x) => s + x, 0) / r.total * 100).toFixed(1)}% | frame ms avg ${(t.reduce((s, x) => s + x, 0) / t.length).toFixed(2)} p50 ${pct(t, 0.5).toFixed(2)} p95 ${pct(t, 0.95).toFixed(2)} max ${Math.max(...t).toFixed(1)} | errs ${errs.length}`);
    await ctx.close();
  }
  await b.close();
})();
