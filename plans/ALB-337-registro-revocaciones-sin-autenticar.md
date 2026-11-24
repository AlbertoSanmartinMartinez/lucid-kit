# ALB-337 · Hub: cualquiera, sin autenticar, puede añadir entradas permanentes al registro de transparencia

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-337
- **Rama:** `info/alb-337-seguridadmedium-hub-cualquiera-sin-autenticar`
- **Prioridad:** Medium (seguridad)
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.

## El problema

`POST /v1/revocations` no pide autenticación, y está bien que no la pida: una revocación vale por la firma de quien emitió la delegación, la entregue quien la entregue. Pero el hub apunta **cualquier** revocación bien firmada, también la de una clave recién creada para una delegación inventada. Cada una queda para siempre en el registro de transparencia, en disco y en memoria, y todo cliente que sigue el registro tiene que descargarla. El único freno son 20 por minuto y por IP.

El registro solo crece: lo apuntado no se puede limpiar después.

Hay tres huecos vecinos, del mismo tipo:

- Una instancia que se registra otra vez con el mismo certificado deja una entrada nueva cada vez.
- No hay cupo por agente para añadir y quitar instancias, y cada cambio es una entrada.
- Leer las revocaciones no tiene límite propio, y recorre la lista entera en cada petición.

## Decisión del dueño

**Una revocación de un emisor y un agente que el hub no conoce se rechaza, diciéndolo.** Sin promesas a medias: quien revoca sabe que en este hub no ha quedado nada, y la presenta otra vez cuando el agente aparezca.

La otra salida era guardarlas en una memoria acotada. Se descartó: quien quisiera colar una delegación revocada podría llenar esa memoria de basura para que el hub olvidara la suya, y quien revocó habría recibido un OK.

## Cambios

Todos en `src/hub/` (`server.mjs` y `store.mjs`), más una línea en el CLI.

### 1. Qué revocaciones se apuntan

| La revocación… | Qué hace el hub |
|---|---|
| Es de la delegación que un agente activo está usando | Retira al agente, como hoy |
| Nombra a un agente registrado en este hub, o la firma un emisor del que este hub ya tiene delegaciones o revocaciones | La apunta, para que esa delegación no se pueda presentar. Con cupo: 20 sin usar por agente y 1.000 por emisor |
| Ni el agente ni el emisor son de este hub | **`404 unknown_delegation`**: no se apunta nada |
| Pasa del cupo | `403 quota_exceeded` |

Los cupos se cuentan a partir del registro al arrancar y se llevan al día al aplicar cada operación. Se comprueban en el servidor, antes de apuntar: las reglas del registro (`Directory`) no llevan cuotas.

### 2. Leer las revocaciones

`GET /v1/revocations` gana su límite por red, y busca por posición en vez de recorrer la lista.

### 3. Instancias

- **Registrarse otra vez con el mismo certificado** no apunta nada: el hub contesta lo mismo que la primera vez.
- **Cupo por agente** para añadir y quitar instancias, y límite por red en `DELETE /v1/instances/:did`, que hoy no lo tiene.

### 4. El CLI

`agenthub controller revoke` explica el código nuevo: este hub no conoce ni al agente ni al emisor, no ha apuntado nada, y la revocación se puede presentar otra vez cuando el agente esté registrado ahí.

## Lo que esto cambia, y se dice

Hoy un controlador puede revocar una delegación en un hub donde nadie lo conoce, antes de que su agente llegue. Con este cambio, no. No es una pérdida real: tendría que hacerlo en todos los hubs del mundo, uno por uno. Lo que de verdad protege ese caso es la caducidad corta de las delegaciones y, para un dominio, quitar la clave de su `did.json` (ALB-333).

## Tests

Con sus casos de ataque, en `test/trust.test.mjs`, `test/instances.test.mjs` y `test/log.test.mjs`:

1. **Una revocación de una clave recién creada para una delegación inventada:** `404 unknown_delegation`, y el registro no crece.
2. **Mil de ellas,** desde direcciones distintas: el registro sigue igual.
3. **Una revocación previa de un agente ya registrado** se apunta, y esa delegación ya no se puede presentar. Tampoco tras reiniciar el hub.
4. **Una de un emisor que el hub ya conoce,** para un agente que aún no está: se apunta.
5. **Los cupos:** la 21.ª sin usar para un mismo agente, y la 1.001.ª de un mismo emisor, se rechazan. Los cupos se cuentan igual después de un reinicio.
6. **La revocación de una delegación en uso** sigue retirando al agente en el acto, como hoy.
7. **Una instancia que se registra dos veces con el mismo certificado:** una sola entrada en el registro.
8. **El cupo de cambios de instancias** y el límite de `DELETE`.
9. **`GET /v1/revocations`:** su límite, y las mismas respuestas que hoy con `after` y `limit`.
10. Lo que comprueba `startHub` al cerrar cada hub de prueba (que el registro cumple sus reglas) sigue pasando.

Estas áreas no tienen guion de mutaciones: cada defensa se comprueba a mano quitándola.

## Documentación

- `README.md`, donde habla de revocar: qué apunta un hub y qué no, y el código nuevo. Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva con la decisión, lo descartado y lo que cambia.
- `CLAUDE.md`, regla «Validación en el hub»: lo que deja una entrada en el registro la deja solo quien el hub conoce, y con cupo.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`: `tour.sh` y `succession.sh` revocan y cambian instancias de verdad.

## Fuera de este issue

- **El límite por red en vez de por dirección:** ALB-317, del que este arreglo no depende.
- **Otras entradas del registro** que pueda dejar quien no cuesta nada: las de agentes y topics ya pasan por el registro con prueba de trabajo y por sus cupos.
