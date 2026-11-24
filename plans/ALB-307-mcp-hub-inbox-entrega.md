# ALB-307 · MCP: `hub_inbox` confirma los mensajes antes de entregarlos al modelo

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-307
- **Rama:** `info/alb-307-mcp-hub_inbox-confirma-los-mensajes-antes-de`
- **Prioridad:** Medium
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.
- **Va después de ALB-303:** usa su cancelación (`notifications/cancelled`) para saber que una llamada no llegó.

## El problema

`hub_inbox` llama a `client.poll()`, que abre los mensajes y los confirma en el hub antes de que la respuesta de MCP llegue al cliente. Si el cliente corta la llamada por tiempo, la cancela, o falla la escritura de la respuesta, los mensajes ya están confirmados y nadie los vuelve a ver.

Releerlos del hub no lo arregla: sobre MLS un mensaje abierto no se puede abrir otra vez, porque su clave se borra al usarla. Quien tiene que guardarlo hasta entregarlo es el servidor MCP.

## Decisión del dueño

**Se repite si la llamada se cancela o falla.** El servidor MCP guarda en memoria el lote ya abierto hasta que la respuesta ha salido. Si no sale, lo entrega otra vez en la siguiente llamada, marcado como repetido. Nada nuevo en disco.

La garantía que queda, y que se documenta:

| Qué pasa | Qué ve el modelo |
|---|---|
| La llamada se cancela, o la respuesta no se pudo escribir | Los mismos mensajes en la siguiente llamada a `hub_inbox` |
| La respuesta llegó, pero el cliente la canceló tarde | Los mensajes dos veces, la segunda marcados como repetidos |
| El proceso del servidor MCP muere con un lote sin entregar | Ese lote se pierde |

## Cambios

Todos en `src/mcp/server.mjs`. El SDK no cambia: `poll()` sigue confirmando en el hub lo que abrió.

### 1. El lote sin entregar

El servidor guarda `undelivered`: los mensajes que una llamada a `hub_inbox` abrió y cuya respuesta todavía no ha salido.

- **Al contestar `hub_inbox`:** la respuesta lleva primero lo que hubiera sin entregar, marcado, y después lo nuevo. Todo ello pasa a ser el lote sin entregar.
- **Cuando la respuesta se ha escrito** y la llamada no se canceló: el lote se da por entregado y se olvida.
- **Si la llamada se cancela o la escritura falla:** el lote se queda, y sale en la siguiente llamada.

Para eso el servidor avisa a la herramienta de cómo acabó su respuesta: hoy escribe y no mira el resultado.

### 2. Una lectura cancelada a medias no pierde lo que ya abrió

Con ALB-303, cancelar una llamada aborta sus peticiones al hub, y para el SDK eso es un hub que no contestó: `poll()` devuelve lo que llevaba abierto y deja el resto en el buzón (`retry_later`). El servidor guarda eso como lote sin entregar aunque la llamada no reciba respuesta. Un test lo fija, porque es lo que se rompería sin avisar.

### 3. Lo que se le dice al modelo

- **La descripción de la herramienta** deja de decir «un mensaje no se puede leer otra vez»: dice que cada llamada trae los mensajes nuevos, y que si una respuesta no llegó, la siguiente los repite.
- **Los repetidos** van bajo una línea del propio servidor: `These were already sent in an answer that may not have arrived:`. Cada mensaje sigue envuelto como siempre: lo que escribió otro agente es dato.

## Tests

En `test/mcp.test.mjs`:

1. **`hub_inbox` con cancelación:** una llamada cancelada mientras se escribe su respuesta; la siguiente trae los mismos mensajes, marcados como repetidos, con los nuevos detrás.
2. **`hub_inbox` con la escritura fallando** (una salida que rechaza la escritura): lo mismo.
3. **Una lectura cancelada a medias:** con un hub que deja de contestar en el segundo mensaje, el primero, ya abierto, sale en la llamada siguiente, y el segundo sigue en el buzón.
4. **Entregado es entregado:** tras una respuesta que salió bien, la siguiente llamada no repite nada.
5. **Sobre MLS:** el mensaje repetido es el mismo texto ya abierto; no se intenta abrir otra vez.
6. **Lo repetido sigue siendo dato:** envuelto y con `<` escapado.

## Documentación

- `README.md`, en la parte de MCP: la tabla de arriba, tal cual. Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva con la decisión y lo que no cubre.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`, que pasa el cliente oficial de MCP.

## Fuera de este issue

- **Guardar el lote en disco** para aguantar la muerte del proceso: se descartó, porque deja mensajes descifrados en disco.
- **`listen()` cuando falla quien recibe el mensaje:** ALB-320, que es el mismo problema en el SDK.
- **Que el CLI (`agenthub inbox`) pierda lo leído si se corta su salida:** es un proceso por lectura; no se toca aquí.
