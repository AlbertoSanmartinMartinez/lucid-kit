# ALB-320 · SDK `listen()`: si quien recibe falla, el mensaje se da por entregado, y `ready` puede no acabar nunca

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-320
- **Rama:** `info/alb-320-m5-sdk-listen-si-el-handler-falla-el-mensaje-se`
- **Prioridad:** Medium
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.

## El problema

1. **Si la función de la aplicación lanza un error**, `listen()` avisa por `onError` y aun así confirma el mensaje en el hub. La aplicación lo pierde sin que nada lo diga en la documentación.
2. **`ready` solo se rechaza con un 401 o un 403.** Con el hub caído, o contestando 5xx, `await listener.ready` no acaba nunca.
3. **`close()` no resuelve ni rechaza `ready`:** quien lo esperaba se queda esperando.

## Lo que se propone

El issue propone no confirmar cuando la función falla (`ackOnHandlerError: false`). Este plan propone otra forma de lo mismo, más simple y que vale también sobre MLS:

**Reintentar en el propio proceso, con el mensaje ya abierto.** No confirmar y esperar a que el hub lo mande otra vez no sirve sobre MLS: el mensaje vuelve, pero ya no se puede abrir. En cambio el cliente tiene el mensaje abierto en la mano, y puede dárselo otra vez a la función sin pedir nada a nadie.

Lo que hace hoy no cambia si no se pide: reintentar una función que ya hizo algo antes de fallar repite ese algo, y eso lo tiene que elegir quien la escribe.

## Cambios

Todos en `src/sdk/index.mjs`. Tres opciones nuevas de `listen()`; ninguna cambia lo que pasa si no se dan.

### 1. `handlerRetries` (0 por defecto)

Cuando la función lanza un error:

- **Con 0, como hoy:** se avisa por `onError`, el mensaje se confirma y se sigue.
- **Con N:** se le vuelve a dar el mismo mensaje hasta N veces más, con la pausa creciente que `listen` ya usa. Mientras tanto no se confirma ni se pasa al siguiente: el orden se mantiene. Si falla las N veces, se avisa por `onError`, se confirma y se sigue, para que un mensaje que nadie consigue procesar no pare el stream para siempre.

Si el proceso muere a mitad de los reintentos, lo que iba sobre MLS se pierde y lo demás vuelve del hub. Se dice en la documentación.

### 2. `ready`

- **`close()` antes de conectar** rechaza `ready` con `HubError(0, 'closed', …)`.
- **`readyTimeoutMs`** (sin plazo por defecto): si el stream no ha conectado en ese tiempo, el listener se cierra y `ready` se rechaza con el último error que hubo. Sin la opción sigue como hoy: reintenta para siempre, que es lo que quiere quien deja un agente escuchando a que vuelva su hub.

### 3. Lo que dice la documentación de `listen`

La garantía, escrita donde hoy no lo está:

| Qué pasa | Qué recibe la aplicación |
|---|---|
| La función acaba bien | El mensaje, una vez |
| La función falla, sin `handlerRetries` | El mensaje, una vez; el fallo, por `onError` |
| La función falla, con `handlerRetries` | El mismo mensaje otra vez, hasta el tope |
| El proceso muere antes de confirmar | Otra vez del hub, salvo lo que iba sobre MLS, que ya no se puede abrir |

## Tests

En `test/hub.test.mjs` y, para MLS, `test/mls.test.mjs`:

1. **Sin la opción, como hoy:** la función falla, sale por `onError`, el mensaje queda confirmado y el siguiente llega.
2. **Con `handlerRetries: 2`** y una función que falla una vez: recibe el mismo mensaje dos veces, y el siguiente llega después, no antes.
3. **Con una función que falla siempre:** al agotar los reintentos se avisa, se confirma y el stream sigue.
4. **Sobre MLS:** el reintento entrega el mismo mensaje ya abierto, sin pedir nada al hub.
5. **`close()` antes de conectar,** con un hub que no contesta: `ready` se rechaza con `closed`.
6. **`readyTimeoutMs`** con un hub que contesta 503: `ready` se rechaza al vencer, y el listener queda cerrado.
7. **Sin `readyTimeoutMs`,** el listener sigue intentándolo y conecta cuando el hub vuelve.

## Documentación

- `README.md`, donde enseña `listen`: la tabla de arriba y las tres opciones. Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva, con el porqué de reintentar en el proceso en vez de no confirmar.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`: `tour.sh` deja un `listen` en marcha.

## Fuera de este issue

- **`hub_inbox` en el servidor MCP:** ALB-307, que resuelve lo mismo allí guardando el lote.
- **El plazo de conexión del stream y su vigilancia:** ALB-303 y ALB-315.
- **Que el CLI use los reintentos:** `agenthub listen` solo escribe el mensaje por la salida.
