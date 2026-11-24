# ALB-309 · Tests: caminos de error y límites del hub sin ningún test

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-309
- **Rama:** `info/alb-309-tests-caminos-de-error-y-limites-del-hub-sin`
- **Prioridad:** Medium
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.

## El problema

La cobertura global es alta (96 % de líneas con los tests), pero hay caminos de error y límites de protección que ningún test ejecuta. Varios son justo los que protegen al hub o pierden datos: el buzón que se desborda, el stream lento que se corta, el tope de retos pendientes.

Al escribir este plan salió además un defecto de producto: **cuando un buzón se desborda, nadie se lo dice al agente.** El hub cuenta lo que descartó (`dropped`) y lo manda con el buzón, pero ni el SDK, ni `hub_inbox`, ni el CLI lo leen.

## Lo que se propone

Casi todo son tests. Hay cuatro cambios pequeños de producto: uno arregla el defecto de arriba y los otros tres hacen que se pueda probar sin trucos.

## Cambios de producto

### 1. Avisar de lo que el buzón descartó

- **Hub:** `dropped` pasa a ser «lo descartado desde la última confirmación». La operación `inbox.ack` lo pone a cero. Así cualquier valor distinto de cero es una noticia, y el cliente no tiene que recordar nada entre ejecuciones.
- **SDK:** `poll()` devuelve también `dropped`, comprobado como número entero.
- **Servidor MCP:** `hub_inbox` añade una línea suya: `The hub dropped N older message(s) because this agent's inbox was full.` Es un número del hub: de lo poco que una herramienta puede repetir de él.
- **CLI:** `agenthub inbox` lo dice por la salida de errores.

### 2. Dos límites que hoy son números escritos en el código

`maxPendingChallenges` (10.000) y `maxStreamBacklogBytes` (8 MB) pasan a la configuración del hub, con los mismos valores por defecto. Un test los baja en vez de mandar diez mil peticiones u ocho megas.

### 3. `RateLimiter.size`

Cuántos cubos guarda: para comprobar que `sweep` limpia. El reloj ya se puede inyectar.

### 4. `fetchDidDocument`, exportada para su test

Con dos opciones que el resolutor no pasa nunca: qué `lookup` usar y qué autoridad de certificación aceptar. No abre nada que no estuviera abierto: el resolutor ya admite que se le dé entera la función que busca el documento.

## Tests

| Test | Dónde | Qué comprueba |
|---|---|---|
| El buzón se desborda | `test/hub.test.mjs` | `dropped` sube, el mensaje más antiguo desaparece, y lo dicen `poll()`, `hub_inbox` y el CLI. Después de confirmar, vuelve a cero |
| Un stream lento se corta | `test/hub.test.mjs` | Un lector que no lee: al pasar del tope el hub cierra el stream; el cliente reconecta y recupera del buzón, sin perder ni repetir |
| Demasiados retos pendientes | `test/hub.test.mjs` | `503 busy` al pasar del tope; los caducados se limpian y vuelve a aceptar |
| Un error inesperado | `test/hub.test.mjs` | `500 internal_error` con el mensaje fijo: el texto del error de dentro no sale en la respuesta. El hub sigue atendiendo |
| Una petición que se corta a medias | `test/requests.test.mjs` | El hub la da por terminada (`400 bad_request`), no se queda esperando y sigue atendiendo |
| `sweep` del limitador | `test/abuse.test.mjs` | Con el reloj inyectado, los cubos sin uso desaparecen y los recientes no |
| `did:web` contra un servidor HTTPS local | `test/trust.test.mjs` | Una redirección se rechaza; un cuerpo de más de 64 KB; un JSON que no lo es; un servidor que no contesta a tiempo; y un nombre que resuelve a una dirección privada, con el `lookup` de verdad y `localhost` |
| El CLI | `test/cli.test.mjs`, nuevo | Las órdenes que hoy solo ejercitan los guiones de `checks/`: `witness`, `verifier`, `guardian`, `delegation` y `key`, con el proceso de verdad contra un hub de prueba |

Reglas de siempre: sin red de fuera, sin esperas fijas, y los procesos se paran por su PID.

Para el servidor HTTPS local hace falta un certificado. Node no sabe hacer uno, y los tests no deben depender de `openssl`: va uno de prueba en `test/fixtures/`, autofirmado, para un nombre de prueba, con una nota que dice que su clave no protege nada.

## Documentación

- `README.md`: qué pasa cuando un buzón se llena y cómo se entera el agente. Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva: el defecto encontrado y lo que sigue sin test.

## Comprobación

- `npm test` en verde antes y después.
- La cobertura, medida antes y después con el corredor de tests de Node, anotada en el issue. El umbral en la CI es de ALB-313.
- `bash checks/all.sh`.

## Lo que sigue sin test, y se dice

- **El verificador contra GitHub de verdad** y **`did:web` contra un dominio real:** ALB-330.
- **El flujo de dispositivo del verificador**, más allá de lo que ya cubren sus dobles: ALB-331.

## Fuera de este issue

- **Esperas fijas y reloj real en los tests que ya hay:** ALB-310.
- **Umbral de cobertura en la CI:** ALB-313.
