# ALB-306 · SDK: varios procesos con la misma identidad pueden corromper el estado de MLS

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-306
- **Rama:** `info/alb-306-sdk-varios-procesos-con-la-misma-identidad`
- **Prioridad:** Medium
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.
- **Va después de ALB-327:** usa el mismo candado que el directorio de datos del hub.

## El problema

`fileStateStore` guarda el estado de MLS en ficheros sueltos, sin nada que impida que dos procesos lo usen a la vez (`agenthub listen` en una terminal y `agenthub send` en otra; dos clientes de MCP con la misma identidad):

1. Cada uno lee el estado, avanza y escribe: el último que escribe gana, y lo que hizo el otro se pierde.
2. Los dos escriben al mismo `<fichero>.tmp` y pueden pisarse a mitad.

Con secreto hacia adelante, un avance perdido deja mensajes o grupos ilegibles para siempre. No se ha reproducido: sale de leer el código.

## Lo que se propone

**El segundo proceso se rechaza, con un error claro.** El issue admite las dos salidas (convivir o rechazar) y este plan elige rechazar, a falta de que el dueño diga otra cosa:

- Es el modelo del proyecto: cada copia en ejecución de un agente es una instancia, con su clave y su estado. Dos procesos sobre el mismo estado van contra él, y el hub ya lo trata así: un segundo stream del mismo lector echa al primero (`stream_replaced`).
- Hacerlos convivir pediría un candado en cada operación y que nada del estado de MLS viva en memoria entre dos operaciones: una regla frágil, fácil de romper sin que ningún test lo note.
- Es la misma decisión que el dueño tomó para el directorio de datos del hub (ALB-327).

Lo que cambia para quien lo usa: mientras `agenthub listen` o el servidor MCP están en marcha con una identidad, otra orden con esa misma identidad no arranca. Quien quiere dos a la vez da a cada una su instancia.

## Cambios

### 1. El candado, compartido: `src/core/lockfile.mjs`

El candado que ALB-327 escribe para el hub (un fichero con `{ pid, host, at }` y sus reglas: de un proceso vivo en esta máquina no se pasa, el de un proceso muerto se toma) se saca a `src/core/`, que es Apache: lo usan el hub y el SDK. El SDK no puede importar del hub.

### 2. `src/sdk/state.mjs`

- **`fileStateStore(dir)` toma `<dir>/lock`** la primera vez que lee o escribe, y lo suelta al acabar el proceso. Si lo tiene otro proceso vivo:
  `this agent's state in <dir> is in use by another process (<pid>): run one at a time, or give each its own instance`.
- **El mismo proceso puede abrir el directorio dos veces**, como en el hub: los tests que simulan un reinicio lo hacen.
- **Nombre temporal único por escritura:** `<fichero>.tmp.<pid>.<aleatorio>`. `keys()` ignora todo nombre que lleve un punto: los de las entradas van en base64url y nunca lo llevan.

### 3. CLI y servidor MCP

Nada: el error sale como cualquier otro del CLI. En `mcp` va por la salida de errores y el proceso termina antes de contestar, con el mensaje de arriba.

## Tests

En `test/mls.test.mjs`, que es donde está el estado en disco:

1. **Dos procesos con la misma identidad:** un `node` hijo de verdad tiene abierto el directorio; un segundo no arranca y dice por qué. Cuando el primero acaba, el segundo arranca.
2. **El candado de un proceso muerto con `SIGKILL` se toma.**
3. **El mismo proceso abre el directorio dos veces** y funciona.
4. **Escrituras intercaladas en el mismo proceso** no se pisan: cada una usa su temporal, y `keys()` no enseña ninguno.
5. **Un cliente sin estado en disco** (`state: null`, o en memoria) no crea ningún candado.

En `test/mcp.test.mjs`: un segundo servidor MCP con la misma identidad termina con ese mensaje por la salida de errores y nada por la estándar.

## Documentación

- `README.md`: una identidad, un proceso a la vez; para más, instancias. Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva con la decisión y su porqué.
- `CLAUDE.md`, regla «Estado de MLS»: el estado de un agente en disco es de un solo proceso.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`: `tour.sh` deja un `listen` en marcha mientras corre otras órdenes; se confirma que ninguna usa su misma identidad a la vez, o se ajusta el guion.

## Fuera de este issue

- **`fsync` del estado del agente:** un corte de luz puede dejarlo en un estado anterior al que ya usó. Anotado en el plan de ALB-302; sigue sin issue propio.
- **Dos máquinas con la misma identidad copiada:** el candado es de un directorio en una máquina. Entre máquinas lo dice el hub (`stream_replaced`), y la respuesta vuelve a ser instancias.
