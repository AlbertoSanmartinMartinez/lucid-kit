# ALB-308 · Federación: la versión del protocolo no se comprueba, y la compatibilidad entre versiones no se prueba

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-308
- **Rama:** `info/alb-308-federacion-la-version-del-protocolo-no-se`
- **Prioridad:** Medium
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.

## El problema

1. **Cada hub anuncia su protocolo de federación** (`agenthub-federation/v1`) en `/v1/info` y al contestar un `hello`, pero quien pregunta no lo mira. Un par con un protocolo futuro o desconocido queda como `paired`, y los fallos salen después como `peer_unreachable`, sin decir que la causa es la versión.
2. **Las comprobaciones entre versiones** (`upgrade.sh`, `mixed-hubs.sh`, `mixed-clients.sh`) no corren en `all.sh` ni en la CI: sacan la versión anterior del historial, y este repositorio empieza en la 1.0.0.

## Lo que se propone

Sin decisiones nuevas: el issue fija el comportamiento, y `checks/README.md` ya dice qué pasa con las comprobaciones al cerrar la versión siguiente.

## Cambios

### 1. `checkHello`, en `src/hub/federation.mjs`

- Recibe también el `protocol` de la respuesta y lo compara con los que este hub habla (hoy, uno).
- Si es otro, o falta: devuelve el problema, y `checkPairing` deja al par en **`mismatch`** con un `detail` que lo dice: `it speaks another version of the federation protocol (<el suyo>) than this hub (<el nuestro>)`.
- **Lo que escribe otro hub es dato:** su protocolo solo se enseña al operador si tiene la forma esperada (letras, cifras, `.`, `/` y `-`, hasta 40 caracteres). Si no, el detalle dice `an unknown one`.

El campo va fuera de lo que el otro hub firma en el `hello`. No hace falta firmarlo: sirve para decir por qué dos hubs no se entienden, no para decidir de quién fiarse.

### 2. Lo que hace `mismatch`

Lo mismo que hoy con los otros motivos de `mismatch`: el estado se enseña al operador (al arrancar, en `/v1/federation/peers` y en las métricas). No se añade ningún bloqueo nuevo: lo que se pida a ese par fallará como falla hoy, pero ya está dicho por qué.

En el emparejamiento abierto, un hub que pide emparejarse y contesta con otro protocolo se rechaza con `pairing_unconfirmed`, que ya existe para `mismatch`.

### 3. Las comprobaciones entre versiones

Al cerrar la versión siguiente a la 1.0.0, como dice `checks/README.md`:

- `OLD_REV` en `checks/lib.sh` pasa a ser `v1.0.0`.
- `all.sh` pasa las tres, y con ello la CI, que ya baja el historial entero para esto.
- **Sus expectativas cambian**, por dos planes anteriores: con ALB-346 el protocolo se renombra, así que la 1.0.0 y la siguiente no se entienden y lo que se comprueba es que se rechazan con un error claro; con ALB-314 el CLI está en otro sitio en cada árbol, y `lib.sh` tiene que saberlo.

El trabajo manual contra la 0.6 (`AGENTHUB_OLD_TREE`) se acaba ahí: la 0.6 no está en este repositorio y deja de ser la referencia.

## Tests

En `test/federation.test.mjs`, con el `fetch` que se le da al hub de prueba cambiando la respuesta del otro:

1. **Un par con protocolo `…/v2`:** queda en `mismatch`, no en `paired`, y el detalle nombra las dos versiones.
2. **Un par sin el campo:** `mismatch`.
3. **Un par cuyo protocolo no tiene la forma esperada** (texto largo, con saltos de línea o con `<`): `mismatch`, y su texto no aparece en el detalle ni en lo que el hub escribe a su operador.
4. **Un par con el mismo protocolo** sigue en `paired`.

En `test/pairing.test.mjs`:

5. **Emparejamiento abierto con otro protocolo:** `pairing_unconfirmed`, y nada queda guardado.

No hay guion de mutaciones para la federación mínima; la comprobación nueva se prueba a mano quitándola.

## Documentación

- `README.md`, en federación: qué significa `mismatch` por versión. Número de tests, ahí y en `CLAUDE.md`.
- `checks/README.md`: las tres comprobaciones entran en `all.sh`, y contra qué versión.
- `docs/HANDOFF.md`: sección nueva.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`, ya con las tres comprobaciones de versiones cuando exista la versión siguiente.

## Fuera de este issue

- **Negociar versiones** (que dos hubs elijan la más alta que hablan los dos): hoy solo hay una.
- **Meter el protocolo dentro de lo firmado en el `hello`.**
- **Un job programado en la CI:** ALB-313 recoge las mejoras del workflow.
