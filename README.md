# IRON SIEGE

Autobattler táctico de mechas 1v1 inspirado en Mechabellum. **Un solo archivo (`index.html`)**: HTML + CSS + JS puro,
sin build y sin servidor propio. Los jugadores se conectan directo entre navegadores (WebRTC vía PeerJS) y se publica como
sitio estático (Cloudflare Pages).

## Cómo se juega

Partida al mejor de 5 (gana quien llega a 3 rondas). Cada ronda:

1. **Planificás** (90 s la primera, 60 s las siguientes): desplegás mechas con créditos, los **movés**, los **fusionás**
   (dos iguales del mismo nivel → +1 nivel) o investigás **tecnologías** por unidad.
2. Confirmás **LISTO**. Cuando los dos confirman, el combate se simula y se reproduce (velocidad 0,5×–4×).
3. Los supervivientes vuelven con el HP que les quedó y ves el despliegue y las techs del rival de la ronda anterior (intel).

Triángulo de contras: **enjambre > pesado > rango > enjambre**; el asalto es generalista (`TYPE_ADV` en el código).

### Modos
- **Buscar partida rápida**: cola abierta sin servidor propio (ver *Matchmaking* abajo).
- **Jugar con un amigo (1v1 privado)**: creás una sala y le pasás el **código** o el **enlace** (`?sala=CODIGO`).
- **Revancha** directa al terminar, **replays** de todas tus partidas (se comparten por enlace) y **reconexión** si se corta.

## Arquitectura (todo en `index.html`)

El `<script>` está dividido en secciones con cabeceras `/* ---------- ... ---------- */`:

| Sección | Qué hace |
|---|---|
| RNG, Unit catalog, Game state | `makeRNG` (mulberry32), `UNITS`, `TYPE_ADV`, `lvlMult`, estado `G` |
| Networking, Connection health, Reconnection | PeerJS, latidos, reconexión con token, `startHosting`/`startJoin` |
| Matchmaking without a server | buzones con ID fijo (`ironsiege-v1-q-N`) |
| Match flow, Rematch, Shop, Field/deploy | flujo de ronda, tienda, despliegue/mover/fusionar, temporizador |
| **Simulation** | `expand` + `simulate`: **determinista**, único lugar donde se decide el combate |
| Renderer & effects, Audio, Playback | canvas con sprites cacheados, partículas, Web Audio sintetizado |
| Battle summary, Replays | estadísticas de ronda, grabación/códec/visor |

### Reglas que NO hay que romper
1. **La simulación es determinista y sagrada.** Ambos navegadores corren la misma `simulate(...)` con la misma entrada
   y obtienen el mismo resultado; nunca se envía el estado del combate. Dentro de `simulate`/`expand` no se permite
   `Math.random`, `Date`, orden de iteración inestable ni nada que dependa de la máquina. Todo el azar sale de `makeRNG(seed)`.
   `Math.random` solo se usa fuera de la sim (códigos de sala, semillas iniciales, efectos visuales).
2. **Si cambiás las reglas** (`simulate`, `expand`, `UNITS`, `TYPE_ADV`, `lvlMult`) hay que **subir `SIM_VERSION`** y correr
   `node tests/run.js --update-fingerprint`. Un test lo exige: los replays guardados dependen de que la misma entrada dé el mismo
   resultado, y avisan cuando se grabaron con otra versión.
3. **Compatibilidad entre builds**: el apretón de manos incluye `SIM_VERSION` (reglas) y `NET_VERSION` (protocolo). Si no coinciden
   la conexión se rechaza con un mensaje claro ("recargá la página"). Subí `NET_VERSION` al cambiar el formato de los mensajes.
4. **Sin infraestructura propia**: nada de servidores, bases de datos ni servicios pagos. El único servicio externo es el de
   señalización público de PeerJS.
5. Todo lo que llega por red o por un enlace de replay se **sanea** (`sanitizeDeploy`, `sanitizeTech`, `sanitizeReplay`).
6. El dibujo y el audio son solo de presentación: no pueden leer ni alterar el estado de la simulación.

## Tests

Solo requieren Node (≥ 18, probado con 22):

```bash
node tests/run.js                 # sintaxis, triángulo, determinismo, red simulada, replays, matchmaking, balance...
node tests/run.js --report        # además imprime tablas de balance
node tests/run.js --update-fingerprint   # tras un cambio DELIBERADO de reglas (con SIM_VERSION subida)
```

Con Playwright + Chromium (opcionales, no corren en CI):

```bash
NODE_PATH=$(npm root -g) node tests/mobile-smoke.js   # 5 tamaños de pantalla táctil
NODE_PATH=$(npm root -g) node tests/perf.js           # costo de dibujo por frame
```

Cómo funcionan: `tests/load.js` carga el `<script>` de `index.html` en un contexto de Node con un DOM falso;
`tests/net.js` + `tests/fakepeer.js` simulan varias máquinas sobre una red PeerJS falsa con reloj controlado;
`tests/balance.js` ofrece métricas de balance reproducibles.

## Balance

`tools/balance-search.js` propone constantes (stats, costos, curva de fusión) minimizando una pérdida basada en el triángulo, los
duelos por unidad y la fusión. Siempre hay que validar el resultado con otra semilla (`node tests/run.js --report`).

## Matchmaking sin servidor

Existen unos pocos "buzones" (`ironsiege-v1-q-0…5`). Buscar = intentar reclamar el 0: si se logra, quedás esperando; si ya está
tomado, alguien espera y lo llamás. El que espera crea una sala privada normal y le pasa el código por el buzón, que se libera
a los pocos segundos. Los que esperan en buzones > 0 re-escanean desde el 0 para no quedar separados.

## Despliegue

Cloudflare Pages: sin build, directorio raíz del repo, sin comando de compilación. `_headers` agrega cabeceras de seguridad.

## Limitaciones conocidas
- Depende del servicio público y gratuito de PeerJS (sin garantías de disponibilidad).
- Una sola cola de matchmaking, sin filtros por nivel; un usuario malicioso podría ocupar un buzón (mitigado, no evitable sin servidor).
- Si un jugador pasa la app a segundo plano en un teléfono más de ~2 minutos, el rival da la partida por interrumpida.
- Redes con NAT muy estricto pueden necesitar un servidor TURN propio (las versiones recientes de PeerJS suelen incluir uno público por defecto; no está verificado en este repo ni tiene garantías).
