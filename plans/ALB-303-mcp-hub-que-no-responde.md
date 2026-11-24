# ALB-303 · MCP: un hub que no responde bloquea el servidor entero

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-303
- **Rama:** `info/alb-303-mcp-un-hub-que-no-responde-bloquea-el-servidor`
- **Prioridad:** High
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.

## El problema

1. **El SDK no pone plazo a lo que pide al hub.** Un hub que acepta la conexión y calla deja la petición esperando los 300 s que da Node por defecto.
2. **El servidor MCP atiende todo en una sola cola.** Mientras una herramienta espera al hub, nada más se contesta, ni siquiera `ping`. Los clientes de MCP cortan a los 60 s y dan el servidor por caído.
3. **`notifications/cancelled` se descarta.** Quien cancela una llamada sigue esperándola.

## Lo que se propone

Dos valores que el issue deja abiertos y este plan fija, a falta de que el dueño diga otra cosa:

| Qué | Valor | Por qué |
|---|---|---|
| Plazo por defecto de una petición al hub | 30 s | El que sugiere el issue; cabe en los 60 s de los clientes de MCP |
| Código del error | `hub_timeout`, nuevo | No es lo mismo que `hub_unreachable`: lo pedido puede haberse hecho, y el modelo tiene que saberlo antes de repetirlo |

## Cambios

### 1. SDK: plazo y abandono (`src/sdk/index.mjs`)

- **`requestTimeoutMs`**, opción nueva de `AgentClient` (30.000 por defecto).
- **Cada petición lleva su propio `AbortController`**, que se dispara al vencer el plazo o al abortar la señal de quien llama. El plazo cubre la respuesta entera: cabeceras y cuerpo. Sin `AbortSignal.any`, que no está en todo Node 20.
- **Al vencer:** `HubError(0, 'hub_timeout', 'the hub at <url> did not answer in <n> s')`. Lo escribe el SDK (`fromHub: false`).
- **El stream de `listen()`** tiene plazo solo hasta que llegan las cabeceras: después vive lo que tenga que vivir.
- **`client.withSignal(signal, task)`**, método nuevo: mientras corre `task`, todo lo que el cliente pida al hub queda atado a `signal`. Si aborta, lo que estaba esperando falla y lo que se pida después falla al momento, así que una operación de varios pasos no sigue adelante. Es para quien ya hace sus llamadas de una en una, como el servidor MCP, y así se documenta.

Abortar una petición es, para el resto del SDK, lo mismo que un hub que no contestó: el estado de MLS ya se guarda antes de enviar, y los pasos a medias ya se reintentan.

### 2. Servidor MCP (`src/mcp/server.mjs`)

- **Solo `tools/call` pasa por la cola.** `ping`, `initialize`, `tools/list`, los métodos desconocidos y los errores de protocolo se contestan al llegar. Las llamadas a herramientas siguen de una en una y en orden: las lecturas de `hub_inbox` no compiten.
- **`notifications/cancelled`** con su `requestId`:
  - si es la llamada en curso, aborta su señal;
  - si está esperando turno, se marca y no llega a empezar.

  Una llamada cancelada no recibe respuesta, como dice la especificación de MCP, y la cola sigue con la siguiente.
- **Cada llamada corre dentro de `client.withSignal(...)`** con la señal de su cancelación.
- **`HINTS.hub_timeout`:** el hub no contestó a tiempo; lo pedido puede haberse hecho o no, y hay que mirarlo antes de repetir algo que deba pasar una sola vez.

## Tests

Sin red de fuera ni esperas fijas: el hub mudo es un `fetch` que se le pasa al cliente y que no contesta hasta que abortan su señal, y los plazos de los tests son de 200 ms.

En `test/hub.test.mjs`, del SDK:

1. **Un hub que calla:** la petición falla con `0 hub_timeout` al vencer el plazo configurado.
2. **Un hub que manda las cabeceras y se para en el cuerpo:** lo mismo.
3. **El stream no se corta por el plazo:** `listen()` sigue abierto pasado `requestTimeoutMs`.
4. **`withSignal`:** al abortar, la petición en curso falla; otra dentro de la misma tarea falla al momento; acabada la tarea, el cliente vuelve a pedir con normalidad.

En `test/mcp.test.mjs`:

5. **Un hub mudo no bloquea `ping`:** con una llamada a herramienta esperando, `ping` se contesta en menos de 1 s. Es el guion de QA del issue, con la afirmación al revés.
6. **`notifications/cancelled` aborta la llamada en curso:** no recibe respuesta, y la que esperaba detrás se atiende.
7. **Una llamada cancelada antes de su turno** no llega a pedir nada al hub ni recibe respuesta.
8. **El plazo llega al modelo:** `isError: true`, `Error - hub_timeout: …` y su explicación, antes del límite configurado.
9. **Dos `hub_inbox` seguidos** siguen sin solaparse: la segunda lectura empieza cuando acabó la primera.

En `checks/mcp-client/flow.mjs`, con el cliente oficial de MCP: una llamada cancelada con su `signal` y un `ping` mientras otra llamada espera.

## Documentación

- `README.md`: `requestTimeoutMs` y `withSignal` en el SDK; `hub_timeout` entre los códigos de error; en MCP, que `ping` no espera y que una llamada se puede cancelar. Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva con lo que se fijó y por qué.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`, que pasa `checks/mcp-client`.

## Fuera de este issue

- **Una opción `{ signal }` en cada método del SDK.** Sería la interfaz completa; `withSignal` da lo que hace falta hoy con unas pocas líneas.
- **Elegir el plazo desde el CLI o por variable de entorno.** Hoy, el valor por defecto.
- **Un plazo para la llamada entera a una herramienta**, que puede hacer varias peticiones seguidas.
- **Las funciones sueltas del SDK** que no son del cliente (`submitRevocation`, las atestaciones, el verificador): las usa una persona desde el CLI.
- **Que `hub_inbox` confirme antes de entregar:** ALB-307. **Tope de tamaño y redirecciones:** ALB-315, que toca la misma función y va después de este.
