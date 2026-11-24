# ALB-311 · CLI: errores poco claros al validar argumentos numéricos

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-311
- **Rama:** `info/alb-311-cli-errores-poco-claros-al-validar-argumentos`
- **Prioridad:** Low
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.

## El problema

El CLI convierte sus opciones numéricas con `Number(...)` y no mira el resultado. Lo que ve quien se equivoca es confuso, o directamente una traza de Node:

| Orden | Hoy contesta |
|---|---|
| `--days abc` | `days must be positive`: no es negativo, es que no es un número |
| `--days -5` | Una traza entera de `TypeError` |
| `--days 1e9` | `Invalid time value` |
| `--port abc` | `options.port should be >= 0 and < 65536. Received type number (NaN)` |

## Lo que se propone

Sin decisiones nuevas. Dos cambios en `bin/agenthub.mjs`.

### 1. Una función para leer un número

`numberOf(nombre, valor, { min, max })`: comprueba que es un número entero y que está en su rango, y si no, falla con el mensaje de siempre del CLI:

```
error: --days must be a whole number between 1 and 90
```

Se usa en todas las opciones numéricas, las doce que hoy pasan por `Number(...)`:

| Opción | Rango |
|---|---|
| `--port`, `--metrics-port` | 0 a 65.535 |
| `--days` | 1 al máximo que admite cada orden (delegaciones, certificados de instancia, atestaciones) |
| `--pow` | 0 al máximo que el hub admite |
| `--trust-proxy` | 0 o más |
| `--open-pairing`, `--witness-quorum` | 1 o más |

Los máximos salen de donde ya están en el código, no se escriben otra vez en el CLI. Las opciones numéricas que añaden otros planes (`--max-connections`, `--did-web-recheck`) usan la misma función.

Vale también para lo que llega por variable de entorno (`PORT`, `TRUST_PROXY`): el mensaje nombra la variable.

### 2. Los errores de leer la línea de órdenes

`parseArgs` lanza una excepción con una opción desconocida, o con un valor que empieza por guion. Hoy sale como traza. Se recoge y se enseña con el mismo formato, `error: …`, y salida 1.

Un valor negativo se sigue escribiendo `--days=-5`, que es lo que pide Node y lo que su mensaje explica. Con eso llega a la comprobación del punto 1, que dice que está fuera de rango.

## Tests

En `test/cli.test.mjs` (el fichero que crea ALB-309, o aquí si este issue va antes), con el proceso de verdad:

1. **Para cada opción numérica:** un valor que no es un número, uno negativo, uno fuera de rango, uno enorme (`1e9`) y uno con decimales. En todos: un mensaje que nombra la opción y su rango, salida 1 y **ninguna traza**.
2. **Un valor bueno** sigue funcionando en cada una.
3. **Una opción que no existe:** `error: …` y salida 1, sin traza.
4. **Por variable de entorno:** `PORT=abc` da el mismo tipo de mensaje, nombrando la variable.

«Sin traza» se comprueba de una forma simple: la salida de errores tiene una sola línea y no contiene `at ` seguido de una ruta.

## Documentación

- La ayuda del CLI ya dice los valores por defecto; se añade el rango donde no es evidente.
- `README.md` y `CLAUDE.md`: número de tests.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`: sus guiones pasan valores buenos, y lo confirman.

## Fuera de este issue

- **Las opciones que no son números** (direcciones, DIDs, ficheros), que ya tienen sus comprobaciones.
- **La lengua de los mensajes del CLI** y un ejemplo por defecto en `topic create`: ALB-355.
