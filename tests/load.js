// Carga el <script> de index.html en un contexto de Node con stubs de DOM,
// y expone las funciones internas para testear (simulate, UNITS, etc.).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// IRONSIEGE_HTML permite apuntar a una copia congelada del juego (p. ej. para que una búsqueda larga de balance no vea ediciones en curso)
const HTML_PATH = process.env.IRONSIEGE_HTML || path.join(__dirname, '..', 'index.html');

function extractScript(html) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (blocks.length !== 1) throw new Error('Se esperaba exactamente un <script> inline, hay ' + blocks.length);
  return blocks[0];
}

// contexto 2D falso: cualquier método devuelve otro objeto encadenable (gradientes, etc.)
function ctxStub() {
  return new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : ctxStub()), set: () => true, apply: () => ctxStub() });
}

function stubEl() {
  const el = new Proxy(function () {}, {
    get(t, k) {
      if (k === 'value' || k === 'textContent' || k === 'innerHTML') return k in t ? t[k] : '';
      if (k === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (k === 'style') return {};
      if (k === 'dataset') return {};
      if (k === 'getContext') return () => ctxStub();
      if (k === 'querySelector') return () => stubEl();
      if (k === 'querySelectorAll') return () => [];
      if (k === 'getBoundingClientRect') return () => ({ left: 0, top: 0, width: 1000, height: 440 });
      if (k in t) return t[k];
      return () => stubEl();
    },
    set(t, k, v) { t[k] = v; return true; },
    apply() { return stubEl(); },
  });
  return el;
}

function makeContext(extraSandbox = {}) {
  const els = new Map();                                // como el DOM real: mismo id, mismo elemento
  const sandbox = {
    document: { body: stubEl(), addEventListener() {}, getElementById: id => { if (!els.has(id)) els.set(id, stubEl()); return els.get(id); }, querySelectorAll: () => [], createElement: () => stubEl(), addEventListener() {} },
    window: { addEventListener() {} },
    navigator: {},
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Peer: function () { throw new Error('Peer no disponible en tests'); },
    TextEncoder, TextDecoder, btoa, atob, CompressionStream, DecompressionStream,   // códec de replays
    ...extraSandbox,
  };
  sandbox.window.setTimeout = setTimeout;
  return vm.createContext(sandbox);
}

// names: lista de identificadores top-level a exponer
function loadGame(names = ['simulate', 'UNITS', 'TYPE_ADV', 'G', 'makeRNG', 'lvlMult', 'expand'], extraSandbox = {}) {
  const src = extractScript(fs.readFileSync(HTML_PATH, 'utf8'));
  const ctx = makeContext(extraSandbox);
  const exportCode = `\n;globalThis.__api = { ${names.map(n => `get ${n}(){ return typeof ${n}==='undefined'?undefined:${n}; }`).join(', ')} };`;
  vm.runInContext(src + exportCode, ctx, { filename: 'index.html<script>' });
  return { api: ctx.__api, ctx };
}

module.exports = { loadGame, extractScript, HTML_PATH };
