# ALB-348 · README en inglés y recorrido de 5 minutos con `npx`

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-348
- **Rama:** `info/alb-348-readme-en-ingles-y-recorrido-de-5-minutos-con`
- **Prioridad:** Medium
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada cambiado.

## Antes de este issue

| Issue | Por qué va antes |
|---|---|
| ALB-346 | El README se escribe ya con el nombre nuevo: LUCID, `lucid`, `LUCID_*` |
| ALB-314 | Los nombres de los paquetes, y dónde queda el CLI (su decisión sigue pendiente) |
| ALB-328 | El recorrido usa `npx`, que necesita los paquetes publicados |

La mudanza del README (pasos 1 a 3) no depende de publicar y se puede hacer antes. El recorrido (paso 4) se escribe cuando haya paquete.

## El problema

- **La documentación útil está solo en español.** La web en inglés avisa: «The README, in Spanish for now».
- **El README tiene 791 líneas** y empieza por el historial de las versiones 0.2 a 0.7 antes de decir qué es el proyecto y para quién.
- **El primer contacto pide tres terminales** y una ruta absoluta al clon para registrar el servidor MCP.

## Decisión del dueño

**El detalle del README de hoy va a `docs/`, en español y tal cual.** No se traduce ahora: son unas 600 líneas técnicas, y serían dos versiones que mantener iguales.

Esto cambia una convención del proyecto: el README pasa a estar en inglés, con su versión en español al lado. El resto de la documentación sigue en español.

## Cómo queda

| Fichero | Qué lleva | Lengua |
|---|---|---|
| `README.md` | Qué es, para quién, el recorrido de 5 minutos, qué está comprobado y qué no (en corto) y enlaces. 150 líneas como mucho | Inglés |
| `README.es.md` | Lo mismo | Español |
| `docs/GUIA.md` | Del README de hoy: inicio rápido, uso desde Claude Code, uso desde código, cómo funciona, desplegarlo | Español |
| `docs/REFERENCIA.md` | Del README de hoy: la API HTTP, los límites por defecto, la estructura, las diferencias con el diseño, lo que no incluye y lo que no está probado | Español |
| `CHANGELOG.md` | El historial de versiones que hoy abre el README | Español |

El `CHANGELOG.md` es también el punto B10 de ALB-326: lo hace quien llegue primero.

## Pasos

Un commit cada uno.

**1. Mover, sin reescribir.** El texto de hoy pasa a `docs/GUIA.md`, `docs/REFERENCIA.md` y `CHANGELOG.md` tal cual, con sus títulos. Se arreglan los enlaces internos y nada más.

**2. Los dos README cortos.** Con una regla que se mantiene de la convención de hoy: el README distingue lo implementado, lo no verificado y lo que falta. En corto, con un enlace a la lista entera en `docs/REFERENCIA.md`.

**3. Lo que apuntaba al README.** `CLAUDE.md` (que dice que el README documenta el uso y el protocolo, y en qué lengua van los textos), `AGENTS.md`, `site/` (la frase «in Spanish for now» y el enlace a lo que falta, en las dos lenguas) y los `README` de `checks/` y `experiments/`.

**4. El recorrido de 5 minutos.** «Dos sesiones de Claude Code se escriben cifrado a través de LUCID»:

1. Un hub en marcha, con una orden de `npx`.
2. En cada sesión, el servidor MCP registrado con **una línea** y sin ruta al clon: `claude mcp add …  -- npx -y <paquete> mcp`, cada una con su identidad.
3. Lo que se le pide a cada sesión para que se registren, se encuentren y se escriban.

Las órdenes exactas dependen de la decisión del CLI de ALB-314.

## Que el recorrido no se quede viejo

Un README que promete cinco minutos y falla en el segundo paso hace más daño que no tenerlo.

- **`checks/packages.sh`** (de ALB-314) hace el recorrido con los paquetes empaquetados: arranca el hub y dos servidores MCP con las mismas órdenes, y con el cliente oficial de MCP hace lo que el README pide a cada sesión: registrarse, buscarse, escribirse y leer.
- **Un test** comprueba que las órdenes que salen en los dos README son, letra por letra, las que pasa ese guion.
- **La parte de Claude Code** no se puede automatizar: se prueba a mano al escribirlo, y el README dice con qué versión y qué día.

## Tests

En `test/package.test.mjs`:

1. **Los dos README dicen lo mismo:** los mismos títulos, en el mismo orden, y los mismos bloques de órdenes.
2. **`README.md` tiene 150 líneas como mucho** y no empieza por el historial.
3. **Las órdenes del recorrido** son las del guion.
4. **Ningún enlace interno roto** en los README y en `docs/`.

`test/site.test.mjs` sigue manteniendo iguales las dos páginas de la landing.

## Documentación

- `CLAUDE.md`, «Convenciones»: el README en inglés con su versión en español; lo demás, en español. Y la regla «Honestidad en la documentación», que pasa a nombrar también `docs/REFERENCIA.md`.
- `docs/HANDOFF.md`: sección nueva.

## Comprobación

- `npm test`.
- `bash checks/all.sh`, con `packages.sh`.
- El recorrido, a mano, con dos sesiones de Claude Code y cronómetro: si no sale en cinco minutos, se recorta.

## Fuera de este issue

- **Traducir el detalle al inglés.**
- **El README de cada paquete en npm:** ALB-328.
- **Un hub público al que conectarse** sin montar el propio: ALB-349. Hasta entonces el recorrido arranca un hub en local.
- **La especificación del protocolo:** ALB-351.
