# ALB-304 · Federación: DNS rebinding (SSRF) en el emparejamiento abierto

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-304
- **Rama:** `info/alb-304-federacion-dns-rebinding-ssrf-en-el`
- **Prioridad:** High
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.

## El problema

Con `--open-pairing`, un hub que se empareja solo da su dirección. El hub abierto comprueba **una vez**, al emparejar, que ese nombre resuelve a direcciones públicas. Después le sigue pidiendo cosas (`hello`, búsquedas, el stream de federación) con el `fetch` global, que resuelve el nombre otra vez en cada conexión y no comprueba nada.

Quien controla el DNS de ese nombre contesta con una dirección pública durante la comprobación y con `127.0.0.1` o una de la red interna después. El hub manda entonces peticiones firmadas con su clave a servicios internos. Pasa ya en el propio emparejamiento: la comprobación y el `hello` son dos resoluciones distintas.

El hallazgo sale de leer el código. No se ha montado el ataque.

## Lo que se propone

**Comprobar en cada conexión, en el mismo paso que conecta**, como ya hace `did:web` (`publicOnlyLookup` en `src/core/didweb.mjs`). Comprobar antes de cada petición y dejar que `fetch` resuelva después no sirve: son otra vez dos resoluciones.

**Sin dependencia nueva.** El `fetch` de Node no deja elegir cómo se resuelve un nombre sin el paquete `undici`. En su lugar, unas 30 líneas propias sobre `node:https`, que sí lo deja, igual que `did:web`. Es una decisión de este plan, a falta de que el dueño diga otra cosa.

**A quién se aplica:** a los hubs que se emparejaron solos (`store.pairings`) y al que lo está pidiendo, salvo que el operador permita direcciones privadas (`openPairing.privateAddresses`). Los pares que nombra el operador y los testigos siguen igual: su dirección es configuración, y a menudo es de una red propia.

## Cambios

### 1. `src/hub/publicfetch.mjs`, nuevo (AGPL)

`publicFetch({ lookup, timeoutMs })` devuelve una función con la forma de `fetch` para lo que el hub usa de ella (`method`, `headers`, `body`, `signal`):

- **Solo HTTPS.** Otra cosa se rechaza.
- **El nombre se resuelve al abrir cada conexión** con el `lookup` del hub, dentro del plazo de un par, y la conexión solo se abre si **todas** las direcciones son públicas (`isPublicAddress`). Si no, falla sin abrir ningún socket.
- **Una dirección escrita tal cual** no pasa por `lookup`, así que se juzga antes de pedir.
- **Conexiones reutilizadas** con un agente propio (`keepAlive`): una conexión que se reutiliza ya se abrió a una dirección comprobada. El agente se cierra con el hub.
- **Una redirección es un error**, como hoy con `redirect: 'error'`.
- **La respuesta es un `Response` normal** sobre el cuerpo que llega: `status`, `ok` y `body` funcionan como esperan quienes la usan, también `chunksUntil` en el stream.

### 2. `src/hub/server.mjs`

- **`resolvePublic(host)`:** lo que la ruta de emparejamiento hace hoy en línea (resolver con plazo y exigir que todo sea público), como función. La usan esa ruta, para contestar `invalid_peer_address`, y el `lookup` de cada conexión.
- **`reach(peer)`:** qué `fetch` toca. El público para un par que se emparejó solo, o que lo está pidiendo; el de siempre para los demás.
- **Se usa en** `askPeer`, `opensPairing` y el stream de federación. El `hello` del emparejamiento pasa por él.
- **Con un `fetch` dado al hub** (los tests), la comprobación se hace igual, con `resolvePublic` antes de cada petición, y la petición sale por el `fetch` dado.

No cambia el protocolo ni lo que se guarda. Un par emparejado así cuyo nombre deja de resolver a direcciones públicas pasa a `unreachable`, y lo que se le pida da `peer_unreachable`, como si no contestara.

## Tests

En `test/pairing.test.mjs`, con `lookup` y `fetch` inyectados (sin DNS ni red de fuera):

1. **Rebinding:** el `lookup` da una dirección pública mientras el hub se empareja y `127.0.0.1` después. La siguiente petición al par se rechaza y el `fetch` no llega a llamarse. Lo mismo con una respuesta mixta (una pública y una privada).
2. **El stream de federación** hacia ese par tampoco se abre después del cambio.
3. **`checkPairing`** lo deja en `unreachable`.
4. **Un par que nombró el operador** en `127.0.0.1` sigue funcionando: no se le aplica.
5. El test que ya cuenta las resoluciones al emparejar se pone al día: ahora hay una por petición.

En `test/publicfetch.test.mjs`, nuevo, contra un servidor local:

6. **Un nombre que resuelve a `127.0.0.1`:** la petición se rechaza y el servidor local no recibe ninguna conexión.
7. **Una dirección privada escrita tal cual** se rechaza sin preguntar a `lookup`, y `http://` también.
8. **El transporte en sí:** estado, cabeceras y cuerpo llegan bien, una redirección es un error, y abortar corta un stream. Como en esta máquina no hay direcciones públicas, este test le dice a la función qué direcciones acepta y usa HTTP en claro: es lo único que cambia respecto a producción.

Cada defensa nueva lleva su mutación en `experiments/mutations/pairing.py`, que es el guion de esta área.

## Documentación

- `README.md`, «Emparejamiento abierto»: la dirección se comprueba en cada conexión, no solo al emparejar. Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva: por qué en el paso que conecta, por qué sin `undici`, y lo que no está verificado.
- `CLAUDE.md`, regla «Federación»: a un hub que se emparejó solo se le habla solo en direcciones públicas, comprobadas al conectar.

## Comprobación

- `npm test` en verde antes y después.
- `python3 experiments/mutations/pairing.py`: todas cazadas.
- `bash checks/all.sh`: los pares de `two-hubs.sh` los nombra el operador y van por el camino de siempre.

## Lo que no queda verificado

Una petición que **sí** sale, por HTTPS de verdad y a una dirección pública, no se puede probar en esta máquina. La primera vez que se ejercita es en ALB-330 (dos hubs en dos máquinas), que este issue bloquea.

## Fuera de este issue

- **Los pares que nombra el operador** y los testigos.
- **El SDK y las redirecciones hacia el hub:** ALB-315.
- **Los puertos de `did:web`:** ALB-341.
