# IRON SIEGE — guía para trabajar en este repo

Autobattler de mechas P2P. **Un solo archivo `index.html`** (HTML+CSS+JS, sin build, sin dependencias salvo PeerJS por CDN).
Se publica como sitio estático (Cloudflare Pages). Ver `README.md` para la arquitectura completa.

## Reglas innegociables
- **Simulación determinista**: `simulate()`/`expand()` solo usan `makeRNG(seed)`. Prohibido `Math.random`, `Date`, `performance`, orden
  de iteración inestable o lectura de estado visual dentro de la simulación. `Math.random` solo fuera de la sim.
- **Cambiar reglas ⇒ subir `SIM_VERSION`** y `node tests/run.js --update-fingerprint` (un test lo exige; protege los replays).
- **Cambiar el protocolo de red** (formato de mensajes o apretón de manos) ⇒ subir `NET_VERSION`. El `hello` lleva `SIM_VERSION` y
  `NET_VERSION`: un rival con otra versión se rechaza antes de empezar (`versionRefuse`), así dos builds distintos nunca se desincronizan en silencio.
- **Triángulo de contras** (enjambre > pesado > rango > enjambre): si tocás stats/costos, verificá con
  `node tests/run.js --report` y con una semilla distinta a la usada para ajustar.
- **Sin servidor propio ni infraestructura paga.** Todo entrante (red, enlaces de replay) se sanea.
- Reglas estilo Mechabellum: **el ejército completo se restaura a pleno HP cada ronda** (destruidas y supervivientes; `PERSIST_DAMAGE=false`).
- **Vida de base**: gana quien destruye la base rival (1000 HP); el daño sale de `simulate()` (`baseDmg`, de los sobrevivientes del ganador). Cambiarlo ⇒ `SIM_VERSION`.
- **Desbloqueos**: 4 unidades iniciales y 1 de 3 por ronda desde la 2. Las ofertas son deterministas (`unlockOffer`, semilla compartida) y el rival
  se valida con ellas en `applyFoeReady`: desbloqueo fuera de la oferta o unidad no desbloqueada ⇒ rechazo. Los tests desbloquean todo por defecto
  (`handshake`/`makeNetPair`, salvo `keepLocks`). Agregar una unidad: entrada en `UNITS` (con `fx` de una familia existente), caso de tecnología en `expand`, balancearla
  (`tools/balance-search.js` con `FOCUS=id`) y subir `SIM_VERSION`.
- **Fin de partida y ranking**: al terminar, `showEndScreen` ofrece BUSCAR OTRA PARTIDA / REVANCHA / MENÚ; `scoreMatch` suma 3 pts por victoria y 1 por empate en `localStorage` (`ironsiege.scores`), por nombre sin distinguir mayúsculas, una vez por partida (`G.scored`); vs bot no suma. Salir de una partida online en curso con el botón cuenta como derrota (`abandonMatch`). Es local al navegador: sin servidor no hay ranking global. Nombres = entrada hostil (tabla sin prototipo, saneada).
- Mantener: niveles por fusión, tecnologías por unidad, intel del rival, velocidad 0.5×–4×, modal de stats.
- Mantener el proyecto como **un solo `index.html`** salvo acuerdo explícito.

## Flujo de trabajo
- Una rama por mejora → cambio → `node tests/run.js` → commit con mensaje claro.
- **Instrucción permanente del dueño: toda mejora terminada y con los tests en verde se lleva a PRODUCCIÓN** (merge a `main` y push, sin pedir
  confirmación). Antes de publicar: suite completa en un clon limpio (`git clone` + `node tests/run.js`). Después de publicar, avisar que
  los jugadores deben recargar la página. Lo que NO esté probado o falle no se publica.
- Antes de dar por buena una mejora visual, medir con `tests/perf.js` (Playwright) y revisar capturas en pantallas táctiles
  (`tests/mobile-smoke.js`). Presupuesto actual: ~2 ms/frame de dibujo con 72 unidades (raster por software).
- Cambios de red: probar con `tests/net.js`/`fakepeer.js` (varias máquinas, cortes, intrusos). No asumir el comportamiento del
  servidor público de PeerJS: la red falsa lo modela solo en lo que el código usa.

## Mapa rápido
Secciones del `<script>` (buscar `/* ---------- `): RNG → UNITS/TYPE_ADV → estado `G` → red/reconexión/matchmaking →
flujo de partida/tienda/despliegue → renderizador y efectos → audio → **Simulación** → reproducción → resumen → replays → modal.
Tests: `tests/run.js` (suite), `load.js` (carga el script con DOM falso), `net.js`+`fakepeer.js`+`fakeaudio.js` (máquinas simuladas),
`balance.js` (métricas), `perf.js`/`mobile-smoke.js` (Playwright). Herramientas: `tools/balance-search.js` (constantes de balance), `tools/match-sim.js` (partidas bot-vs-bot para medir el ritmo).
El bot (`botTurn`, sección *Practice bot*) debe seguir las mismas reglas que un humano y entrar por `onFoeReady`; usa su propio rng.

## Trampas conocidas
- `G.phase` gobierna qué mensajes de red se aplican (`lobby|plan|battle|between|over|replay`); un `ready` adelantado se bufferea.
- Posiciones (y el HP arrastrado, si se reactiva `PERSIST_DAMAGE`) están cuantizados (0,1 px / 0,1 %) para que los replays sean compactos: no los desquantices.
- Las pruebas con `Date.now()` real no funcionan con el reloj falso: usar `nowMs()`.
