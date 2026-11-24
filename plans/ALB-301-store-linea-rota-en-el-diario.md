# ALB-301 · Store: una línea rota en `journal.jsonl` hace perder operaciones confirmadas

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-301
- **Rama:** `info/alb-301-store-una-linea-rota-en-journaljsonl-hace`
- **Prioridad:** Urgent
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.

## El problema

Dos caminos llevan al mismo sitio: un trozo de línea al final del diario, sin salto de línea, y la operación siguiente escrita pegada a él. Esa línea ya no se puede leer, y al arrancar se pierden ella y todas las que vienen detrás, sin ningún error.

1. **Al cargar.** `Store.load()` salta bien la última línea rota, pero solo compacta si reprodujo alguna operación (`replayed > 0`). Si no reprodujo ninguna, reabre el diario con el trozo dentro.
2. **Al escribir.** `commit()` no mira cuántos bytes escribió `fs.writeSync`. Una escritura a medias (disco lleno) deja el trozo, la operación se aplica en memoria y se contesta OK.

## Decisiones del dueño

| Pregunta | Decisión |
|---|---|
| Una línea rota que no es la última | El hub **no arranca y lo dice**, nombrando la línea. Una escritura cortada solo rompe la última: otra cosa es un fichero dañado, y descartar lo que sigue sería perder en silencio operaciones confirmadas |
| Una escritura en el diario que falla | `commit` lanza un error y no aplica nada. El hub **sigue en marcha**: recorta el diario hasta la última operación buena. Solo si ni el recorte se puede hacer, rechaza escrituras hasta que lo reinicien |

## Cambios

Todos en `src/hub/store.mjs`. No cambia ningún formato en disco.

### 1. `load()`

- Una línea que no se puede leer se tolera solo si es **lo último del fichero** (lo que deja una escritura cortada). Cualquier otra lanza `the journal in <dir> is damaged at line <n>` y el fichero no se toca.
- Se compacta **si el diario tenía algo**, en vez de si se reprodujo algo. Así, después de cargar, el diario siempre empieza vacío. Cubre la línea cortada y también una última línea entera a la que le falte el salto de línea.

```js
const lines = fs.readFileSync(journalPath, 'utf8').split('\n');
for (const [i, line] of lines.entries()) {
  if (!line) continue;
  let op;
  try {
    op = JSON.parse(line);
  } catch {
    // Only a write that was cut short leaves a broken line, and only at the very end.
    if (i !== lines.length - 1) throw new Error(`the journal in ${this.dataDir} is damaged at line ${i + 1}`);
    break;
  }
  // ... as now
}
// ...
if (journalHadContent || unrecorded) this.compact();
```

### 2. `commit()`

- La línea se escribe como `Buffer` y se compara lo escrito con su tamaño. El store lleva la cuenta de los bytes buenos del diario (`journalBytes`; `compact()` la pone a cero).
- Si `writeSync` lanza o escribe de menos: se recorta el diario a `journalBytes` y se lanza un error con la causa. `opCount` no avanza y la operación no se aplica.
- Si el recorte también falla: se marca el store (`journalLost`) y todo `commit` posterior lanza hasta reiniciar. Al arrancar, el punto 1 limpia el trozo.

```js
#journal(record) {
  if (this.journalLost) throw new Error('the journal could not be written to: restart the hub');
  const line = Buffer.from(JSON.stringify(record) + '\n');
  let written = 0;
  let cause;
  try {
    written = fs.writeSync(this.fd, line);
  } catch (err) {
    cause = err;
  }
  if (written === line.length) {
    this.journalBytes += written;
    return;
  }
  // Part of a line may be there: take it back out, or the next operation would be written onto it.
  try {
    fs.ftruncateSync(this.fd, this.journalBytes);
  } catch {
    this.journalLost = true;
  }
  throw new Error('could not write to the journal', { cause });
}
```

### 3. Servidor

Nada. El error llega a quien llamaba como `500 internal_error`, que ya existe, y queda en la salida del hub con su causa. El único `commit` fuera de una petición (`event.relay`, lo que llega de otro hub) ya está dentro de un `try` que reintenta sin dar el evento por recibido.

## Tests

En `test/store.test.mjs`. Las escrituras que fallan se inyectan con `t.mock.method(fs, 'writeSync', …)`: el store usa el `fs` por defecto, así que no hace falta ninguna opción nueva en el producto.

1. **Una línea rota y después un commit sobreviven al reinicio.** El guion de QA del issue, con la afirmación al revés: tras el trozo, un commit y una caída (sin `close`), el estado tiene `x1` y `x2`.
2. **Un hub no arranca de un diario con una línea rota que no es la última.** Con la forma que dejaba el bug (`trozo{operación}\n`) y con una línea rota entre dos buenas. El error nombra la línea y el fichero queda como estaba.
3. **Una escritura que falla no aplica nada.** Dos casos: `writeSync` escribe la mitad, y `writeSync` lanza `ENOSPC`. `commit` lanza, el estado y `opCount` no cambian, el commit siguiente funciona, y tras una caída y un arranque están las operaciones buenas y solo ellas.
4. **Si el recorte falla, el store no escribe más.** Con `ftruncateSync` también inyectado: los commits siguientes lanzan, y un arranque nuevo deja el estado bien.

Cada test nuevo se comprueba a mano quitando su arreglo y viendo que falla. El store no tiene guion en `experiments/mutations/`, y este issue no lo añade.

## Documentación

- `README.md`, «Persistencia»: una frase sobre la escritura cortada y el diario dañado. El número de tests (290), ahí y en `CLAUDE.md`.
- `docs/SELF-HOSTING.md`, «Restaurar»: qué hacer si el hub dice que el diario está dañado. Con el hub parado, mirar la línea que nombra: si es un trozo pegado delante de una operación entera (lo que dejaba la 1.0.0 tras una caída a mitad de escritura), borrar el trozo; si no, restaurar la copia de seguridad.
- `docs/HANDOFF.md`: sección nueva con las dos decisiones y su porqué.
- `CLAUDE.md`, regla «Estado»: una escritura en el diario que falla no aplica nada.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`: el store es lo que usan los hubs de verdad de esas comprobaciones.

## Fuera de este issue

- **`fsync` del diario y del snapshot:** ALB-302.
- **El snapshot que no cabe en una cadena:** ALB-327.
- **Una compactación periódica que falla** (disco lleno al escribir el snapshot) lanza desde `commit` cuando la operación ya está apuntada y aplicada. Es otro defecto, vecino de este; se mira con ALB-327, que toca `compact()`.
- **Reparar solo un diario dañado.** El operador decide; el hub no adivina.
- **Versión.** Es un parche (1.0.1): no mueve ficheros ni cambia formatos. Cuándo se etiqueta lo decide el dueño.
