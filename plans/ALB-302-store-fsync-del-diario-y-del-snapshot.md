# ALB-302 · Store: sin `fsync` en el diario ni en el snapshot

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-302
- **Rama:** `info/alb-302-store-sin-fsync-en-journal-ni-snapshot-se`
- **Prioridad:** High
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.
- **Va después de ALB-301 y ALB-327:** añade el `fsync` a la escritura del diario de la primera y al snapshot por líneas de la segunda.

## El problema

El hub contesta OK cuando ha escrito la operación con `writeSync`, y eso solo la deja en la memoria del sistema operativo. Si el proceso muere, no pasa nada. Si se va la luz o cae el sistema:

1. Operaciones ya confirmadas pueden no estar en disco.
2. Al compactar, el `rename` del snapshot y el vaciado del diario pueden quedar en disco antes que el contenido del snapshot: snapshot vacío o a medias, y diario vacío.

Con el registro de transparencia, un hub que vuelve atrás queda rechazado por sus testigos y sus seguidores.

## Decisión del dueño

**`fsync` en cada operación**, antes de aplicarla y de contestar. Lo confirmado está en disco. No hay opción para relajarlo.

El coste: cada escritura espera al disco, y el hub no atiende nada más mientras tanto. Medido aquí, 0,15 ms por operación (disco virtual, ext4); en un disco de nube típico, de 1 a 5 ms.

## Cambios

Todos en `src/hub/store.mjs`. No cambia ningún formato en disco.

### 1. El diario, en `commit()`

Después de escribir la línea entera, `fs.fsyncSync(this.fd)`, y solo entonces se aplica la operación.

Si el `fsync` falla, no se reintenta: después de un `fsync` fallido el sistema puede dar por bueno el siguiente sin haber escrito nada. El store se marca (`journalLost`, de ALB-301), `commit` lanza y no escribe más hasta que lo reinicien.

### 2. El snapshot, en `compact()`

El orden completo, cada paso asegurado antes del siguiente:

| Paso | Qué asegura |
|---|---|
| Escribir `snapshot.json.tmp` y hacerle `fsync` | El contenido del snapshot nuevo está en disco |
| `rename` a `snapshot.json` | |
| `fsync` del directorio de datos | El nombre apunta ya al snapshot nuevo |
| Vaciar el diario y hacerle `fsync` | Solo ahora se suelta lo que el snapshot ya contiene |

Un corte en cualquier punto deja el snapshot anterior con su diario, o el nuevo con un diario que repite lo que ya tiene y se salta al cargar.

### 3. El directorio, en `load()`

Un `fsync` del directorio de datos después de abrir el diario, para que un diario recién creado no desaparezca.

```js
function syncDir(dir) {
  if (process.platform === 'win32') return; // a directory cannot be opened there
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
```

### 4. Un snapshot vacío o a medias

El hub no arranca, y el error lo dice claro: `the snapshot in <dir> is empty or incomplete`, con la causa. Vale para el formato 2 (sin primera línea, o sin la última, que ya comprueba ALB-327) y para uno de la 1.0.0 (un JSON cortado). No se intenta recuperar del diario: en ese estado el diario ya se vació. Con el orden del punto 2, un corte de luz ya no puede dejarlo así.

## Tests

En `test/store.test.mjs`, envolviendo las funciones de `fs` con `t.mock.method` para apuntar el orden de las llamadas y dejarlas pasar:

1. **El orden al compactar:** escribir el temporal → `fsync` del temporal → `rename` → `fsync` del directorio → vaciar el diario → `fsync` del diario.
2. **El orden al confirmar:** escribir en el diario → `fsync` → aplicar. En el momento del `fsync` la operación todavía no está en el estado.
3. **Un `fsync` del diario que falla:** `commit` lanza, el estado no cambia, los commits siguientes se rechazan, y un arranque nuevo deja el store bien.
4. **Un snapshot vacío o truncado al arrancar:** de cero bytes, en formato 2 sin su final y de la 1.0.0 cortado. El hub no arranca, el error nombra el directorio, y los ficheros quedan como estaban.

Cada `fsync` se comprueba a mano quitándolo y viendo que falla su test.

Lo que estos tests no prueban, y se dice: que el disco guarde de verdad lo que `fsync` promete. Eso pide simular la caché del disco (`dm-flakey`, LazyFS) y queda fuera.

## Documentación

- `README.md`, «Persistencia»: cada operación se asegura en disco antes de contestarse.
- `docs/SELF-HOSTING.md`: el ritmo de escritura del hub es el del `fsync` de su disco; un disco de red lento lo frena entero. Qué hacer si el hub dice que su snapshot está incompleto: restaurar la copia de seguridad.
- `docs/HANDOFF.md`: sección nueva con la decisión, su coste medido y lo que no se prueba.
- `CLAUDE.md`, regla «Estado»: primero al diario y al disco, luego se aplica. Número de tests, ahí y en el README.

## Comprobación

- `npm test` en verde antes y después, y que no tarda más de forma apreciable: 41 sitios de los tests usan un directorio de datos.
- `bash checks/all.sh`, que arranca hubs de verdad con sus datos en disco.

## Fuera de este issue

- **El estado del agente en el SDK** (`src/sdk/state.mjs`) se escribe con temporal y `rename`, sin `fsync`: un corte de luz puede dejar a un agente con un estado de MLS anterior al que ya usó. Merece su issue. El testigo ya lo hace bien (`writeDurably` en `src/witness/server.mjs`).
- **`fsync` agrupado** para no esperar al disco en cada operación: pide que `commit` deje de ser síncrono, y eso es rehacer el hub (sección 25 de `docs/HANDOFF.md`).
- **Que compactar no bloquee el bucle de eventos:** ALB-316.
