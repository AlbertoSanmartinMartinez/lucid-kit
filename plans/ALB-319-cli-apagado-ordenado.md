# ALB-319 · CLI: el apagado no tiene plazo ni es idempotente, y un fallo de `close()` queda sin gestionar

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-319
- **Rama:** `info/alb-319-m4-cli-el-apagado-no-tiene-timeout-ni-es`
- **Prioridad:** Medium
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.

## El problema

Al recibir `SIGINT` o `SIGTERM`, el CLI llama a `close()` y después a `process.exit(0)`. Lo hace igual en cuatro sitios: el hub, el testigo, el verificador y `listen`.

1. **Una segunda señal lanza otro `close()`** en paralelo con el primero.
2. **Si `close()` se cuelga, el proceso no acaba.** El hub espera a que terminen sus conexiones con otros hubs antes de cerrar el almacén: si una no termina, el almacén no llega a cerrarse, y Docker o systemd acaban matando el proceso.
3. **Si `close()` falla, nadie recoge el error.**

Un hub matado así arranca después reproduciendo el diario entero.

## Lo que se propone

Lo que dice el issue, con dos precisiones que este plan fija:

| Qué | Valor | Por qué |
|---|---|---|
| Plazo del apagado | 8 s | Cabe en los 10 s que Docker da por defecto antes de matar; la unidad de systemd del repositorio da 30 |
| Qué pasa al vencer | Se cierra el almacén de todos modos, y se sale con 1 | Cerrar el almacén es síncrono y no depende de la red: no hay motivo para saltárselo |

## Cambios

### 1. Una sola forma de apagar (`src/hub/shutdown.mjs`, nuevo)

`shutdownOn(signals, { close, lastResort, timeoutMs })`, que usan los cuatro sitios del CLI:

- **Una vez.** La primera señal empieza el apagado; las siguientes no hacen nada.
- **Con plazo.** Si `close()` no acaba a tiempo, se llama a `lastResort()`, se dice por la salida de errores y se sale con 1.
- **Con el error recogido.** Si `close()` falla, se dice y se sale con 1.
- Si todo va bien, se sale con 0, como hoy.

`lastResort` es, para el hub, cerrar su almacén. Para los demás, nada.

### 2. `hub.close()`, en otro orden (`src/hub/server.mjs`)

| Paso | Hoy | Pasa a |
|---|---|---|
| 1 | Cortar las conexiones con otros hubs y esperarlas | Dejar de aceptar conexiones y cerrar los streams |
| 2 | Cerrar los streams y dejar de aceptar | Cortar las conexiones con otros hubs y esperarlas |
| 3 | Las métricas | Las métricas |
| 4 | El almacén | El almacén, **pase lo que pase** en los pasos anteriores |

Llamarlo dos veces devuelve el mismo apagado, no empieza otro.

### 3. Testigo y verificador

Sus `close()` no tienen el problema del orden: solo ganan el apagado único y con plazo del punto 1.

## Tests

En `test/hub.test.mjs`, para `shutdownOn`, con cierres de mentira y sin esperas fijas:

1. **Un cierre que acaba:** salida 0.
2. **Un cierre que falla:** salida 1, y el error por la salida de errores.
3. **Un cierre que se cuelga:** al vencer el plazo se llama a `lastResort` y se sale con 1.
4. **Dos señales seguidas:** un solo cierre.

Para `hub.close()`:

5. **El almacén se cierra aunque algo anterior falle:** con una conexión a otro hub que no termina, el snapshot queda escrito y el diario vacío.
6. **Llamado dos veces,** cierra una.

Con el proceso de verdad:

7. **Dos `SIGTERM` seguidos a un hub con datos en disco:** sale con 0 una vez, y el arranque siguiente no tiene nada que reproducir.

En Windows las señales no llegan igual a un proceso; lo que ALB-313 decida para esos tests vale para el 7.

## Documentación

- `docs/SELF-HOSTING.md`: cuánto tarda un hub en parar, y que el plazo de Docker o de systemd tiene que ser mayor que 8 s.
- `README.md`: número de tests, y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`: `upgrade.sh` para hubs «como lo haría un operador», y `tour.sh` para `listen` con Ctrl+C.
- `checks/self-hosted.sh`: `docker compose down` deja el snapshot escrito.

## Fuera de este issue

- **`fsync`:** ALB-302. Con él, un apagado a lo bruto ya no pierde nada confirmado; este issue hace que además sea raro.
- **Un plazo configurable.** Hoy, fijo.
- **Avisar a los agentes conectados** antes de cerrar su stream: reconectan solos.
