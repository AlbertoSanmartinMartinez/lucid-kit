# ALB-316 · Store: la compactación es síncrona y serializa todo el estado

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-316
- **Rama:** `info/alb-316-m1-store-la-compactacion-es-sincrona-y`
- **Prioridad:** Medium
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.
- **Va después de ALB-327 y ALB-302:** parte del snapshot por líneas y de su orden de `fsync`.

## El problema

Cada 5.000 operaciones el hub escribe un snapshot de todo su estado, y mientras lo hace no atiende nada. La pausa crece con el estado. ALB-327 quita lo peor (cada evento se escribe una vez), pero queda una parte que no deja de crecer: **el registro de transparencia entero se reescribe en cada snapshot**, y nunca se poda.

## Decisión del dueño

**El registro sale del snapshot a su propio fichero, se mide y se documenta.** Compactar sin bloquear (en un hilo, o a trozos) se deja para cuando las medidas lo pidan: obliga a coordinar el diario con un snapshot que se escribe mientras llegan operaciones, y es bastante más complejo.

## Cambios

En `src/hub/store.mjs`, `src/hub/metrics.mjs` y `deploy/self-hosted/backup.sh`.

### 1. `log.jsonl`: el registro, en un fichero al que solo se añade

Una entrada del registro por línea, en orden. Nunca se reescribe.

**Al compactar**, en este orden:

| Paso | Qué asegura |
|---|---|
| Añadir a `log.jsonl` las entradas nuevas desde la última compactación, y `fsync` | El registro en disco llega, como poco, hasta donde dirá el snapshot |
| Escribir el snapshot, sin el registro, con `log_size` en su primera línea | El snapshot dice cuántas entradas del registro le corresponden |
| `rename`, `fsync` del directorio y vaciar el diario | Como en ALB-302 |

**Al cargar:**

- Las primeras `log_size` líneas de `log.jsonl` son el registro del snapshot.
- **Si hay menos, el hub no arranca** y lo dice: un registro no se inventa.
- **Si hay más**, las de sobra se cortan: son de una compactación que no llegó a acabar, y reproducir el diario las vuelve a sacar iguales.
- **Un snapshot que lleva el registro dentro** (el de la 1.0.0, o uno de ALB-327) se carga como hasta ahora, y pasa a la forma nueva en la primera compactación.

El registro sigue entero en memoria. Lo que cambia es que compactar ya no cuesta en proporción a todo lo que el hub ha apuntado en su vida, sino a lo que cambió desde la última vez.

### 2. Las copias de seguridad

`backup.sh` copia también `log.jsonl`, y **el último**: diario, snapshot y registro. El registro solo crece, así que una copia tomada después del snapshot tiene al menos las entradas que ese snapshot pide.

### 3. Métricas

Dos más en `/metrics`, que son cuentas y no nombran a nadie:

- cuánto tardó la última compactación, en segundos;
- cuánto ocupa el último snapshot, en bytes.

Con sus nombres según quede ALB-346.

### 4. Medir

El guion de `experiments/store-snapshot/` (de ALB-327) gana un caso con un registro grande. Su README lleva la tabla: el tamaño del estado, lo que tarda en compactar y en cargar, antes y después.

## Tests

En `test/store.test.mjs` y `test/log.test.mjs`:

1. **El snapshot no lleva el registro**, y `log.jsonl` crece solo con las entradas nuevas: una compactación sin cambios en el directorio no escribe nada en él.
2. **Una caída entre añadir al registro y renombrar el snapshot:** las líneas de sobra se cortan al cargar, y el registro que queda es el mismo que si no hubiera caído.
3. **Un `log.jsonl` más corto de lo que dice el snapshot:** el hub no arranca, y el error dice el directorio.
4. **Datos con el registro dentro del snapshot** cargan y pasan a la forma nueva al compactar.
5. **Una copia hecha con `backup.sh`** con el hub en marcha y escribiendo arranca, con el registro entero.
6. **Las dos métricas** salen, y dicen algo razonable después de una compactación.
7. Lo que ya comprueba `startHub` al cerrar cada hub de prueba (que el registro cumple sus reglas y que el mapa del directorio es el de lo que tiene) sigue pasando.

## Documentación

- `docs/SELF-HOSTING.md`: `log.jsonl` en la tabla de ficheros; el orden de la copia; y un apartado nuevo, «Cuánto aguanta un hub», con las medidas, la memoria que pide y qué métrica vigilar.
- `README.md`, «Persistencia». Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva con la decisión, las medidas y cuándo reabrir lo de compactar sin bloquear: si, con el tamaño que se documente como razonable, la pausa pasa de un cuarto de segundo.
- `CLAUDE.md`, regla «Registro de transparencia»: el registro se guarda en su fichero, al que solo se añade.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`, con su comprobación de la copia de seguridad (`checks/backup.sh`).

## Fuera de este issue

- **Compactar sin bloquear el bucle de eventos.** Descartado por ahora, con la condición de arriba para reabrirlo.
- **Tener el registro fuera de la memoria** y leerlo del disco cuando se pide.
- **Varias réplicas y el estado en una base de datos:** ALB-334.
