# ALB-315 · SDK: sin tope de tamaño de respuesta ni bloqueo de redirecciones hacia el hub

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-315
- **Rama:** `info/alb-315-a5-sdk-sin-tope-de-tamano-de-respuesta-ni`
- **Prioridad:** High
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.
- **Va después de ALB-303:** toca las mismas funciones (`#request`, `#rawRequest`, `listen`) y usa su control por conexión.

## El problema

El SDK no se fía del hub para el contenido, pero en el transporte no se protege de él:

1. **Lee la respuesta entera** con `res.text()`, sin límite. Un hub malicioso o roto manda una respuesta enorme y el agente la carga en memoria.
2. **Sigue las redirecciones.** En un 307 o un 308 vuelve a mandar el cuerpo de la petición a otro origen.
3. **El stream de `listen()` no vigila el silencio.** Si el hub deja de mandar sus `: keep-alive` (cada 15 s), el stream se queda colgado.

El hub ya se protege así de sus pares (`readPeerAnswer`, `redirect: 'error'`).

## Lo que se propone

Tres valores que este plan fija, a falta de que el dueño diga otra cosa:

| Qué | Valor | Por qué |
|---|---|---|
| Tope de una respuesta (`maxResponseBytes`) | 16 MB | El issue propone 4 MB, pero la página más grande que da un hub con sus límites por defecto son 200 eventos de 64 KB: 12,8 MB. Con 4 MB, pedir 100 eventos de historial podría fallar sin que el hub haga nada malo |
| Silencio que corta un stream (`streamIdleMs`) | 45 s | El del issue: tres avisos del hub seguidos sin llegar |
| Códigos de error nuevos | `response_too_large` y `hub_redirected` | Dicen qué pasó. `hub_unreachable` mandaría a mirar si el hub está en marcha, que no es el problema |

## Cambios

Todos en `src/sdk/index.mjs`, más dos líneas en `src/mcp/server.mjs`.

### 1. Redirecciones, en `fetchFromHub`

Toda petición a un hub sale con `redirect: 'manual'`, y una respuesta 3xx lanza `HubError(status, 'hub_redirected', 'the hub at <url> answered with a redirect, which is not followed: a request is signed for one address')`. Está en `fetchFromHub` y no en el cliente para que valga también para las funciones sueltas (`submitRevocation`, las atestaciones) y para el stream.

El mensaje no repite la dirección a la que mandaba el hub: es texto suyo.

### 2. Tope de tamaño, al leer

`readFromHub(res, max)`: lee el cuerpo a trozos, como `readPeerAnswer` en el hub. Al pasar del tope cancela la lectura y lanza `HubError(status, 'response_too_large', …)`. Sustituye a `res.text()` y `res.json()` en todo lo que lee de un hub: `#request`, la respuesta de error del stream y las funciones sueltas.

`maxResponseBytes`, opción nueva de `AgentClient` (16 MB por defecto). Los eventos del stream ya tienen su tope (`MAX_SSE_EVENT_LENGTH`).

### 3. Vigilancia del stream, en `listen()`

Cada trozo que llega, también un `: keep-alive`, pone a cero un temporizador de `streamIdleMs` (opción nueva, 45 s). Si vence, se corta **esa conexión** y el bucle que ya existe vuelve a conectar con su pausa, desde el último evento visto (`?after=`). No se pierde ni se repite nada: es el camino de cualquier corte.

### 4. Servidor MCP

`HINTS.response_too_large` y `HINTS.hub_redirected`. El segundo es el que verá quien ponga `http://` en `AGENTHUB_URL` cuando el hub está detrás de un proxy que redirige a `https://`: le dice que ponga la dirección en la que el hub está de verdad.

## Tests

En `test/hub.test.mjs`, con un `fetch` dado al cliente o un servidor local que hace de hub; plazos de 100 ms y sin esperas fijas:

1. **Una respuesta mayor que el tope:** `response_too_large`, y no se lee entera. El cuerpo es un stream que cuenta lo que le piden y no acaba nunca: el test comprueba que se canceló.
2. **Una respuesta justo en el tope** pasa.
3. **Un 3xx del hub** (301, 302, 307 y 308): `hub_redirected`, y el destino de la redirección no recibe nada. Con 307 y cuerpo, el cuerpo no se reenvía.
4. **Las funciones sueltas** (`submitRevocation`) tampoco siguen una redirección.
5. **Un stream que se queda mudo** se vuelve a abrir solo, y la segunda conexión pide desde el último evento recibido.
6. **Un stream con sus avisos** no se corta: una sola conexión después de varios avisos.

En `test/mcp.test.mjs`:

7. **Un hub que redirige** llega al modelo como `Error - hub_redirected: …` con su explicación.

Cada defensa se comprueba a mano quitándola y viendo fallar su test.

## Documentación

- `README.md`: `maxResponseBytes` y `streamIdleMs` entre las opciones del SDK, y los dos códigos nuevos. Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva, con el porqué de los 16 MB.
- `CLAUDE.md`, regla «El hub no es de fiar»: tampoco en el transporte: el SDK lee de un hub hasta un tope y no sigue sus redirecciones.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`: los agentes de verdad de esas comprobaciones leen historiales, buzones y el registro, y escuchan streams.

## Fuera de este issue

- **El plazo de las peticiones y la cancelación:** ALB-303.
- **Lo que el SDK lee del verificador** (`askVerifier`), que ya no sigue redirecciones pero tampoco tiene tope de tamaño.
- **Que el hub anuncie cada cuánto manda sus avisos**, para ajustar `streamIdleMs` solo: hoy un hub configurado con avisos más espaciados que 45 s haría reconectar sin necesidad, sin perder nada.
