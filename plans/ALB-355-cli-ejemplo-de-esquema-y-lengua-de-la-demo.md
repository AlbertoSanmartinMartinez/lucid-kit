# ALB-355 · CLI: un ejemplo de esquema en `topic create`, y una sola lengua

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-355
- **Rama:** `info/alb-355-cli-ejemplo-o-esquema-por-defecto-en-topic`
- **Prioridad:** Low
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.
- **Va después de ALB-346 y ALB-348:** el comando se llamará `lucid`, y el README que lo acompaña estará en inglés.

## El problema

1. **`topic create` pide `--schema` y no dice cómo es uno.** Quien lo prueba por primera vez recibe `error: missing --schema`, y la ayuda no trae ningún ejemplo.
2. **Dos lenguas en el mismo recorrido.** La ayuda del CLI, sus errores y las descripciones de las herramientas de MCP están en inglés; la salida de la demo, en español. Quien llega desde la web en inglés se encuentra el cambio a mitad.

## Decisión del dueño

**La demo, en inglés,** como el CLI y como el README nuevo. La documentación de detalle sigue en español.

## Lo que se propone para el esquema

El issue ofrece un esquema por defecto o un ejemplo en la ayuda. Este plan elige **el ejemplo, y no el valor por defecto,** a falta de que el dueño diga otra cosa: un topic es un contrato, y su esquema es lo que lo hace serlo. Un valor por defecto que acepte cualquier cosa crearía, sin que nadie lo decida, topics que no comprueban nada.

## Cambios

### 1. `topic create` (`bin/agenthub.mjs`)

- **La ayuda trae un ejemplo completo,** que se puede copiar y funciona: un topic con su descripción y un esquema pequeño de verdad (un objeto con un campo de texto obligatorio).
- **El error de un esquema que falta lo enseña también:** además de decir qué falta, pone el ejemplo debajo. Es donde lo va a leer quien se lo saltó.
- `--schema` sigue aceptando un fichero o JSON escrito en la línea.

### 2. La demo (`examples/demo.mjs`)

Sus textos pasan a inglés. Son pocos: lo que la demo cuenta de cada paso mientras corre. Lo que hace no cambia.

### 3. La convención

`CLAUDE.md` dice hoy que el README, la demo y los textos para el usuario van en español. Con ALB-348 el README pasó a inglés; con este issue, la demo. Queda así: **lo que el usuario ve al usar el producto** (el CLI, la demo, las herramientas de MCP, el README) va en inglés; **la documentación de detalle** (`docs/`), en español.

## Tests

En `test/cli.test.mjs`:

1. **La ayuda de `topic create` trae un ejemplo.**
2. **El ejemplo funciona tal cual:** el test lo saca de la ayuda, lo ejecuta contra un hub de prueba y el topic queda creado. Un ejemplo que no se ejecuta acaba mintiendo.
3. **Sin `--schema`,** el error dice qué falta y enseña el ejemplo, con salida 1.

Para la demo:

4. **`npm run demo` sigue pasando,** en la CI como hoy.
5. **Su salida no lleva texto en español:** se comprueba con un puñado de palabras de la versión de hoy, que no deben aparecer.

## Documentación

- `README.md` (en sus dos lenguas, tras ALB-348): el ejemplo de `topic create`.
- `CLAUDE.md`, «Convenciones»: lo de arriba.
- `docs/HANDOFF.md`: sección nueva, corta.

## Comprobación

- `npm test` y `npm run demo`.
- `bash checks/all.sh`: `tour.sh` crea topics con el CLI.

## Fuera de este issue

- **Los errores de los argumentos numéricos:** ALB-311.
- **Traducir la documentación de detalle.**
- **Un asistente interactivo** para crear topics.
