# ALB-331 · Verificador de GitHub: TLS o proxy, registro de los errores de GitHub, copia del secreto y logs estructurados

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-331
- **Rama:** `info/alb-331-verificador-de-github-tls-o-proxy-log-de-los`
- **Prioridad:** Medium
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.
- **Conviene antes de ALB-330,** que monta un verificador de verdad.

## El problema

El verificador funciona, pero no está listo para que alguien lo opere:

1. **No sirve HTTPS** y nada dice cómo ponerle un proxy delante. `deploy/self-hosted/` solo cubre el hub.
2. **Se traga los errores de GitHub.** Si GitHub falla o cambia de formato, nadie se verifica y no queda ni una línea que diga por qué.
3. **Su secreto de referencias no está en las copias de seguridad.** Si se pierde, cambian las referencias de cuenta de todo el mundo.
4. **Los logs del hub y del verificador son texto suelto:** sin nivel, sin formato que lea una máquina y sin nada que una una línea con su petición.
5. **El README dice algo que ya no es verdad:** que el nivel de cuenta lo marca a mano el operador. El verificador existe.

## Lo que se propone

El issue deja elegir entre TLS propio o proxy documentado. Este plan elige **el proxy**, a falta de que el dueño diga otra cosa: es como ya se despliega el hub (`deploy/self-hosted/` con Caddy, que saca el certificado solo), y evita una segunda forma de hacer lo mismo.

## Cambios

### 1. El verificador detrás de un proxy (`deploy/self-hosted/`)

- **`docker-compose.yml`:** un servicio `verifier`, opcional (un perfil de Compose), con la misma imagen y la orden `verifier`. Detrás de Caddy, con su dirección pública y `--trust-proxy 1`.
- **`Caddyfile`:** su nombre, cuando se da.
- **`checks/self-hosted.sh`:** lo levanta y le pide `/v1/info` por HTTPS, como ya hace con el hub.

### 2. Los errores de GitHub quedan dichos (`src/verifier/`)

Cada fallo al hablar con GitHub deja una línea con la causa: el paso (pedir el código, cambiarlo, leer la cuenta) y el estado o el código del error. **Nunca el código de dispositivo ni el token.** La verificación sigue como hoy: se vuelve a preguntar en la siguiente vuelta.

### 3. La copia de seguridad (`deploy/self-hosted/backup.sh`)

El guion reconoce un directorio del verificador y copia sus dos ficheros: `verifier-identity.json` (su clave) y `verifier-reference-secret`. Hoy solo sabe copiar un hub.

### 4. Logs estructurados, opcionales (`src/hub/`, `src/verifier/` y el CLI)

`--log-format json` en `hub` y en `verifier`. Sin la opción, todo sale como hoy.

- **Cada línea es un objeto JSON:** la hora, el nivel (`info`, `warn`, `error`), el servicio y el mensaje.
- **`request_id`:** cada petición recibe uno, que vuelve en la cabecera `x-request-id` de la respuesta y va en las líneas que salen al atenderla. Sobre todo, en la de un error inesperado: quien recibe un 500 puede dar su identificador al operador.
- **Lo que eligió otro** (un nombre, un motivo) va en su propio campo. En texto sigue yendo entre comillas y sin caracteres de control, como hoy.

### 5. Documentación desalineada

La fila de «Diferencias con el diseño» del README: el nivel de cuenta lo da un verificador aparte, o el operador a mano.

## Tests

En `test/verifier.test.mjs`:

1. **GitHub falla** (no contesta; contesta 500; contesta algo que no es lo esperado): una línea con el paso y la causa. El doble de GitHub mete un token de mentira en su error, y el test comprueba que no sale en ninguna línea.
2. **Con `--log-format json`,** cada línea es JSON válido con hora, nivel y servicio.

En `test/hub.test.mjs`:

3. **`x-request-id`** va en cada respuesta, y es distinto en cada una.
4. **Un error inesperado** deja una línea de nivel `error` con el mismo `request_id` que recibió quien llamó, y la respuesta sigue sin llevar detalles de dentro.
5. **Un nombre con saltos de línea** elegido por otro no rompe el formato: en JSON, una línea; en texto, entre comillas.

En `checks/`:

6. **`self-hosted.sh`:** el verificador contesta por HTTPS detrás de Caddy.
7. **`backup.sh`:** la copia de un directorio del verificador lleva sus dos ficheros, y un verificador que arranca de ella da las mismas referencias.

## Documentación

- `docs/SELF-HOSTING.md`: un apartado del verificador: cómo se monta, sus dos ficheros y por qué no hay que perderlos, que lleva las verificaciones en curso en memoria (una sola réplica; un reinicio pierde las de los últimos 15 minutos) y `--log-format json`.
- `README.md`: la fila corregida, la opción de logs y el número de tests, también en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh` y `checks/self-hosted.sh`.

## Lo que no queda verificado

Que el verificador hable de verdad con GitHub: ALB-330.

## Fuera de este issue

- **TLS propio en el verificador.**
- **Logs estructurados en el testigo,** y un registro de cada petición atendida.
- **Varias réplicas del verificador,** con las verificaciones en curso fuera de la memoria.
- **El flujo de dispositivo usado para engañar a alguien:** ALB-342.
