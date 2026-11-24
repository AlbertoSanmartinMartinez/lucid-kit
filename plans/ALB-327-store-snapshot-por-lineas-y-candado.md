# ALB-327 · Store: el snapshot copia cada evento una vez por buzón y el hub deja de arrancar

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-327
- **Rama:** `info/alb-327-store-el-snapshot-copia-cada-evento-una-vez-por`
- **Prioridad:** Urgent
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.
- **Va después de ALB-301:** toca las mismas funciones (`load`, `commit`, `compact`) y parte de su código.

## El problema

1. **El snapshot multiplica.** Al publicar, el mismo sobre se encola en el buzón de cada lector: en memoria es un objeto compartido, pero `#serialize()` lo escribe una vez por buzón, y al restaurar cada buzón se queda con su copia.
2. **El snapshot es una sola cadena.** `JSON.stringify` de todo el estado lanza `RangeError` al pasar el límite de V8 (unos 512 MB). `load()` compacta al arrancar, así que el hub no vuelve a arrancar.
3. **Una compactación que falla deja todas las escrituras en 500.** Falla dentro de `commit`, con la operación ya apuntada y aplicada, y cada escritura siguiente la reintenta.
4. **Dos procesos pueden abrir el mismo directorio de datos** y escribir los dos en el diario.

Medido aquí el 24 de noviembre de 2026 con el código de la 1.0.0 (Node 22, el store directo, sobres de unos 600 bytes):

| Buzones × eventos sin confirmar | Snapshot | `compact()` |
|---|---|---|
| 1.000 × 200 | 124 MB | 356 ms |
| 1.000 × 1.000 | `RangeError: Invalid string length` | falla al segundo |

Quitar los duplicados no basta: ocho buzones llenos de mensajes distintos de 64 KB (el tamaño máximo de una petición) pasan también de 512 MB.

## Decisiones del dueño

| Pregunta | Decisión |
|---|---|
| Cómo se escribe el snapshot | **Por líneas, formato 2.** Cada pieza del estado en su línea, como el diario. Ni escribir ni leer construyen una cadena con todo |
| Cómo se impide que dos hubs usen el mismo directorio | **Un fichero con el PID y el nombre de la máquina**, como PostgreSQL. Node no tiene `flock`, así que no hay candado que el sistema suelte solo |

## Cambios

Todos en `src/hub/store.mjs`, salvo una línea en `server.mjs` para pasarle al store dónde escribe el hub sus avisos (`log`).

### 1. Snapshot en formato 2

```
{"version":2,"last_op":1234,"lists":["agents","topics","entries","inboxes",…]}
["agents",{…}]
["entries",{"kind":"topic","topic":"news","envelope":{…},"hub":{…}}]
["inboxes",["did:key:…",{"next":3,"dropped":0,"items":[[1,0],[2,1]]}]]
…
{"end":true}
```

- **La primera línea** dice la versión, la última operación que contiene y qué listas trae. Una lista vacía no tiene líneas, y por eso se nombran: un registro vacío no es lo mismo que un snapshot de antes del registro.
- **Una línea por elemento** de cada lista de las que ya escribe `#serialize()` (un agente, un topic, un buzón, una entrada del registro).
- **`entries`: cada envío, una vez.** Lo que un envío dice igual a todos sus lectores (`kind`, `topic`, `envelope`, `hub`) va en una fila, y cada buzón guarda pares `[seq, fila]`. Dos elementos de buzón son del mismo envío si comparten el mismo objeto `hub`, que el store crea una vez por operación: no hace falta cambiar nada en memoria.
- **La última línea** dice que el snapshot está entero. Uno sin ella no se carga: en un fichero de líneas, un corte limpio entre dos líneas no se notaría de otro modo.
- **Se escribe en tandas** de alrededor de 1 MB al fichero temporal y se renombra al acabar, como ahora. Si algo falla, el snapshot anterior y el diario siguen como estaban.

Al restaurar, cada elemento de buzón vuelve a ser `{ seq, ...fila }`, con el sobre de la fila compartido entre buzones: la memoria no se multiplica al reiniciar, y el snapshot siguiente vuelve a escribirlo una vez.

### 2. Leer por líneas

- `linesOf(file)`: un lector síncrono que da las líneas de un fichero de una en una, leyendo a trozos de 1 MB, y dice de la última si le falta el salto de línea. Junta los trozos de cada línea una sola vez.
- **El snapshot** se lee con él. Si la primera línea dice `version: 1`, esa línea es el snapshot entero de la 1.0.0 y se restaura como hasta ahora. Los eventos que vengan de uno así siguen duplicados en memoria hasta que sus lectores los confirmen.
- **El diario** se lee con él en vez de con `readFileSync(...).split('\n')`. La regla de ALB-301 no cambia: una línea rota vale solo si es la última y le falta el salto de línea.

### 3. Una compactación que falla

- **En `commit()`:** la operación ya está apuntada y aplicada, así que `commit` devuelve su resultado. El fallo se dice al operador con una línea (`log`), y se vuelve a intentar pasadas otras `compactEvery` operaciones. El diario sigue creciendo y conserva todo.
- **En `load()`:** sigue siendo un error que impide arrancar, con su causa. Con el formato 2 ya solo puede ser un fallo del disco, y un hub que no puede escribir en su directorio no debe aceptar nada.
- **En `close()`:** el diario se cierra y el candado se suelta aunque compactar falle; el error sale después.

### 4. Candado del directorio de datos

`<dataDir>/lock`, con `{ pid, host, at }`, creado con `wx` al empezar `load()` y borrado en `close()` si sigue siendo el de este store.

Si al arrancar ya hay uno:

| Lo que dice el candado | Qué hace el hub |
|---|---|
| Otra máquina | No arranca: desde aquí no se puede saber si aquel hub vive |
| Esta máquina, un proceso vivo que no es este | No arranca |
| Esta máquina, y no se puede leer | No arranca |
| Esta máquina, un proceso que ya no existe | Lo toma |
| Esta máquina, este mismo PID (el contenedor que se reinicia) | Lo toma |
| Escrito antes del último arranque de la máquina | Lo toma |

El error dice quién lo tiene y qué hacer: `the data in <dir> is in use by another hub (process <pid> on <host>); if that hub is gone, delete <dir>/lock`.

**Lo que no cubre, y se documenta:** un contenedor que muere sin cerrar y se recrea con otro nombre de máquina encuentra el candado del anterior y hay que borrarlo a mano. Dos contenedores con el mismo nombre de máquina fijado a mano y el mismo PID no se distinguen.

`deploy/self-hosted/backup.sh` copia tres ficheros por su nombre, así que el candado no entra en las copias.

## Tests

En `test/store.test.mjs`, con el store directo (sin HTTP ni firmas):

1. **1.000 suscriptores × 1.000 eventos sin confirmar:** compacta, se cierra, arranca y el estado es el mismo. Tras arrancar, el sobre de un evento es el mismo objeto en dos buzones. Montarlo tarda 0,3 s.
2. **El snapshot crece con los eventos, no con eventos × lectores:** con los mismos eventos y diez veces más suscriptores, el snapshot no llega al doble.
3. **Datos de la 1.0.0:** un snapshot y un diario escritos por el código de la etiqueta `v1.0.0`, guardados en `test/fixtures/`, cargan; al cerrar se escriben en formato 2 y vuelven a cargar igual.
4. **Un snapshot sin su última línea no se carga.**
5. **Una compactación que falla** (con `fs.renameSync` inyectado y `compactEvery: 2`): los commits siguen devolviendo su resultado, el aviso sale, un arranque en seco recupera todo desde el diario, y cuando deja de fallar se compacta.
6. **`close()` con la compactación fallando** cierra y suelta el candado.
7. **El candado:** un segundo proceso (un `node` hijo de verdad) no arranca sobre el mismo directorio y dice por qué; el de un proceso muerto con `SIGKILL` se toma; el de otra máquina no, y el error nombra el fichero; el de antes del último arranque se toma; `close()` lo borra.

Cada test nuevo se comprueba a mano quitando su arreglo.

## Benchmark

`experiments/store-snapshot/` con su README y un guion (`bench.mjs`): monta N buzones × M eventos, y mide el snapshot, `compact()` y `load()`. El README lleva la tabla de antes (la de arriba y la del issue) y la de después.

## Documentación

- `README.md`, «Persistencia»: el snapshot por líneas y el candado. Número de tests, ahí y en `CLAUDE.md`.
- `docs/SELF-HOSTING.md`: `lock` en la tabla de ficheros; qué hacer si el hub dice que sus datos están en uso; y que, escrito un snapshot en formato 2, no se vuelve a la 1.0.0 sin restaurar una copia.
- `docs/HANDOFF.md`: sección nueva con las dos decisiones, lo que el candado no cubre y las medidas.
- `CLAUDE.md`, regla «Estado»: una compactación que falla no hace fallar la operación; el directorio de datos es de un solo proceso.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`. `checks/upgrade.sh` comprobará el paso de la 1.0.0 a la siguiente con datos reales cuando exista esa versión (`checks/README.md`).

## Fuera de este issue

- **Que compactar no bloquee el bucle de eventos**, y el registro de transparencia entero en cada snapshot: ALB-316.
- **`fsync`:** ALB-302.
- **Una métrica** del tamaño del diario o de compactaciones fallidas.
- **El historial de los topics** (`topic.events`) comparte sobres con los buzones y se sigue escribiendo aparte: como mucho una copia más por evento retenido.
- **Versión.** El formato en disco cambia hacia delante: va en las notas de la versión.
