// Smoke test de mobile con Playwright + Chromium emulando teléfonos (táctil, DPR alto).
// No es parte de `node tests/run.js` porque necesita Playwright:
//   NODE_PATH=$(npm root -g) node tests/mobile-smoke.js
const { chromium } = require('playwright');
const path = require('path');
const URL = 'file://' + path.join(__dirname, '..', 'index.html');
let failed = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); if (!ok) failed++; };

(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  for (const [w, h] of [[320, 568], [360, 740], [390, 844], [412, 915], [844, 390]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message));
    await pg.route('**/*', r => /^(file|about|data):/.test(r.request().url()) ? r.continue() : r.abort());
    await pg.goto(URL);
    const tag = `${w}x${h}`;
    check(`${tag} lobby sin scroll horizontal`, await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check(`${tag} inputs >= 16px (iOS no hace zoom)`, await pg.evaluate(() => ['playerName', 'joinCode'].every(i => parseFloat(getComputedStyle(document.getElementById(i)).fontSize) >= 16)));
    await pg.evaluate(() => { G.name = 'A'; G.foeName = 'B'; G.isHost = true; G.mySeedPart = 1; G.foeSeedPart = 2; startMatch(); G.gold = 3000; });
    check(`${tag} partida sin scroll horizontal`, await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const small = await pg.evaluate(() => [...document.querySelectorAll('button, .unit-card')].filter(e => e.offsetParent).filter(e => { const r = e.getBoundingClientRect(); return r.height < 36 || r.width < 36; }).map(e => e.id || e.className));
    check(`${tag} objetivos táctiles >= 36px`, small.length === 0, small.join(','));
    const cv = await pg.evaluate(() => { const c = document.getElementById('field'), r = c.getBoundingClientRect(); return { cw: r.width, ch: r.height, bw: c.width, bh: c.height }; });
    check(`${tag} canvas nítido (2x, tope de DPR) y alto usable`, cv.bw >= cv.cw * 1.9 && cv.bw <= cv.cw * 2.1 && cv.ch >= 150, `${Math.round(cv.cw)}x${Math.round(cv.ch)} css, ${cv.bw}x${cv.bh} px`);
    // tocar para desplegar
    await pg.evaluate(() => clickShop('warden'));
    await pg.locator('#field').scrollIntoViewIfNeeded();
    const box = await pg.locator('#field').boundingBox();
    await pg.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height * 0.8);
    check(`${tag} un toque despliega una unidad`, await pg.evaluate(() => G.myDeploy.length) === 1);
    // un gesto de scroll que empieza en el campo NO debe desplegar
    await pg.evaluate(({ x, y }) => { const f = document.getElementById('field'); const o = { pointerId: 7, bubbles: true, pointerType: 'touch' };
      f.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: x, clientY: y })); f.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: x, clientY: y - 60 })); }, { x: box.x + box.width * 0.3, y: box.y + box.height * 0.8 });
    check(`${tag} arrastrar/scrollear sobre el campo no despliega`, await pg.evaluate(() => G.myDeploy.length) === 1);
    // MOVER con toques: elegir la unidad y tocar otro lugar de mi mitad
    await pg.evaluate(() => document.querySelector('[data-mode=move]').click());
    const before = await pg.evaluate(() => ({ x: G.myDeploy[0].x, y: G.myDeploy[0].y }));
    const px = box.x + before.x / 1000 * box.width, py = box.y + before.y / 440 * box.height;
    await pg.touchscreen.tap(px, py);
    await pg.touchscreen.tap(box.x + box.width * 0.15, box.y + box.height * 0.9);
    const after = await pg.evaluate(() => ({ x: G.myDeploy[0].x, y: G.myDeploy[0].y, n: G.myDeploy.length }));
    check(`${tag} MOVER con toques reposiciona la unidad`, after.n === 1 && Math.abs(after.x - 150) < 25 && after.y > 360, JSON.stringify({ before, after }));
    // rotar/redimensionar mantiene el canvas nítido y ajustado
    await pg.setViewportSize({ width: h, height: w }); await pg.waitForTimeout(150);
    check(`${tag} al rotar el canvas se reajusta`, await pg.evaluate(() => { const c = document.getElementById('field'); return Math.abs(c.width / Math.min(devicePixelRatio, 2) - c.getBoundingClientRect().width) < 2; }));
    check(`${tag} sin errores de JS`, errs.length === 0, errs.join('|'));
    await ctx.close();
  }
  await b.close();
  console.log(failed ? `\n${failed} fallaron` : '\nTodo OK'); process.exit(failed ? 1 : 0);
})();
