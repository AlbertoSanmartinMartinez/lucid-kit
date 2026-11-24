# ALB-334 · Escalado horizontal del hub: varias réplicas, con el estado en Postgres y la entrega en un bus

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-334
- **Rama:** `info/alb-334-escalado-horizontal-del-hub-el-estado-a`
- **Prioridad:** Low
- **Estado:** decidido el 24 de noviembre de 2026. **En este repositorio no se implementa.**

## El problema

El hub es un solo proceso con su estado en un disco. Con varias réplicas detrás de un balanceador se rompe casi todo lo que guarda en memoria: el directorio y los buzones, las peticiones ya vistas (una repetida contra otra réplica pasaría), los límites y las cuotas, el turno de cada conversación de MLS y la entrega en vivo, que solo llega si el lector está conectado a esa réplica.

Arreglarlo es rehacer cómo guarda y cómo reparte el hub. La sección 25 de `docs/HANDOFF.md` ya lo dice: todo el servidor cuenta con que `store.commit` contesta en el momento.

## Decisión del dueño

**Esto corresponde a Lucid Hub Cloud, el hub ofrecido como servicio.** Es trabajo de ese producto y de su repositorio, no del núcleo abierto.

## Lo que significa para este repositorio

- **El hub de aquí sigue siendo de un nodo.** Es lo que alguien monta por su cuenta con `deploy/self-hosted/`, y para eso basta: un proceso, un disco, y una copia de seguridad.
- **No se añade una interfaz de almacenamiento «por si acaso».** Una que pudiera tener detrás una base de datos sería asíncrona, y hacer asíncrono el almacén es justo el cambio grande. Meterla ahora sería pagar ese coste sin el beneficio.
- **Lo que sí se hace aquí** está en otros issues, y es lo que deja el nodo único en buen estado:

  | Issue | Qué aporta |
  |---|---|
  | ALB-327 | Que el hub no se caiga con volumen, y que su directorio de datos sea de un solo proceso |
  | ALB-302 | Que lo confirmado esté en disco |
  | ALB-316 | El registro fuera del snapshot, y cuánto aguanta un nodo, medido y documentado |
  | ALB-317 y ALB-318 | Límites por red y de conexiones |

- **Cuánto aguanta un nodo** queda escrito en `docs/SELF-HOSTING.md` con ALB-316. Es el dato que dirá cuándo hace falta de verdad lo de este issue.

## Lo que el otro repositorio se lleva de aquí

Cuando ese trabajo empiece, lo que el issue ya identifica es su punto de partida: qué estado hay que compartir, y los cuatro criterios (un diseño con las tablas, el bus, el orden de los commits de MLS y la secuencia única del registro; dos réplicas que pasen los tests y las comprobaciones; lo efímero compartido; y cómo se migra desde `snapshot.json` y `journal.jsonl`).

Dos cosas del núcleo que ese diseño tendrá que respetar, porque son promesas hacia fuera y no detalles de implementación:

- **El registro de transparencia es una sola secuencia.** Dos réplicas no pueden apuntar a la vez.
- **Un commit de MLS por época,** aceptado por orden.

## Cambios

Ninguno en el código.

- `docs/HANDOFF.md`: una línea en la hoja de ruta: el escalado horizontal es del servicio alojado, y por qué no hay interfaz de almacenamiento aquí.
- `README.md`, en «Siguientes pasos», donde hoy dice que el objetivo es sustituir el almacén por PostgreSQL y el reparto por NATS: se aclara que eso es del servicio alojado.

## Lo que hace el dueño

Pasar el issue al proyecto del servicio alojado, o cerrarlo aquí con esta decisión escrita.

## Fuera de este issue

Todo lo demás: el diseño, las réplicas y la migración.
