# Mutaciones: que los tests cazan lo que tienen que cazar

Guiones del 16 de noviembre de 2026. No forman parte del producto ni de `npm test`.

**Qué responden.** Si cada defensa del código tiene un test que la vigila. Un test que pasa no dice que haría falta que fallara: para saberlo se quita la defensa y se mira si alguno falla.

**Cómo.** Una mutación es un cambio pequeño que quita una defensa: una comprobación borrada, una condición aflojada, un hash que deja de entrar en la cuenta. Cada guion prueba las suyas de una en una: cambia el fichero, pasa los tests que deberían notarlo y deja el fichero como estaba.

| Sale | Qué significa | Qué se hace |
|---|---|---|
| `caught` | Algún test falló con la defensa quitada | Nada |
| `MISSED` | Los tests pasaron igual: nadie vigilaba eso | Falta un test, o la línea no hacía nada y sobra |
| `NOT FOUND` | El texto de la mutación ya no está en el código, o está más de una vez | El código cambió: se reescribe la mutación contra el de ahora |

**Qué hay.** Un guion por área, desde la tarjeta de A2A. Los bloques anteriores no tienen guion aquí.

| Guion | Área | Mutaciones | Tests que pasa | Sección de `docs/HANDOFF.md` |
|---|---|---|---|---|
| `a2a.py` | La tarjeta de A2A de un agente y lo que el hub sirve de ella | 14 | `a2a` | 28 |
| `oasf.py` | Un agente como registro de OASF | 9 | `oasf` | 29 |
| `pairing.py` | Un hub que se empareja solo: la dirección que da se resuelve, y con plazo | 4 | `pairing` | 30 |
| `witness.py` | Los testigos del registro: qué cofirman, los formatos y qué les pide un cliente | 24 | `witness` | 32 |
| `succession.py` | El cambio de clave de un agente: guardián, relevo y lo que pasa al sucesor | 46 | `succession`, `federation` | 33 |
| `statemap.py` | El mapa que cabe en un hash: su árbol y sus demostraciones | 18 | `statemap` | 34 |
| `logstate.py` | El estado del directorio en el registro, y lo que un hub contesta de un nombre | 34 | `logstate` y, según la mutación, `log`, `succession`, `attestations`, `trust`, `witness` | 34 |

**Resultado.** El 16 de noviembre de 2026, las 149 cazadas. Para guardarlos aquí hubo que poner al día cuatro mutaciones cuyo código había cambiado desde que se escribieron, y se quitó una de `oasf.py` que ningún test podía distinguir del código bueno: el guion dice cuál.

**Cómo repetirlo.** Hacen falta Python 3 y lo que necesitan los tests (Node 20 o superior, `npm install`). Desde cualquier directorio:

```bash
python3 experiments/mutations/statemap.py            # todas las de un área
python3 experiments/mutations/succession.py guardian # solo las que llevan ese texto en su descripción
for area in a2a oasf pairing witness succession statemap logstate; do python3 experiments/mutations/$area.py; done
```

Cada guion acaba con `RESULT: N of M mutations caught` y sale con 0 solo si las cazó todas. Las siete áreas tardan entre veinte y treinta minutos: cada mutación es una pasada de sus tests.

**Cuidado: cambian el código en sitio.**

- **Uno cada vez,** y nada más que lea el código mientras tanto: ni `npm test`, ni otro guion, ni otro agente en la misma copia de trabajo. Con una copia de trabajo por agente (worktrees) no se estorban.
- **Sin hacer `git add` ni commits mientras corre:** se llevaría un fichero mutado.
- **Si se corta de mala manera** (`kill -9`, un apagón), el fichero que se estaba probando se queda mutado. `git status` lo enseña y `git diff` dice qué cambió; `git checkout -- FICHERO` lo deja como en el último commit. Parado con Ctrl+C o con `kill`, el guion lo repone él.
- **Valen sobre código sin confirmar.** Es para lo que más sirven: probar los tests de un cambio antes de entregarlo. Por eso no exigen que el árbol esté limpio.

**Qué no prueban.**

- **Solo las defensas que alguien pensó en mutar.** Una que no está en la lista no está vigilada por esto.
- **Que un test falle no dice que sea bueno,** solo que algo nota el cambio.
- **No miden cobertura** ni sustituyen a los casos de ataque escritos a mano en los tests.

**Cuándo tocarlos.** Quien cambia una de estas áreas pasa su guion. Quien añade una defensa añade su mutación. Un bloque nuevo que lo merezca lleva guion nuevo: unas constantes con los ficheros, la lista `mutations` y una llamada a `run` (`harness.py`).
