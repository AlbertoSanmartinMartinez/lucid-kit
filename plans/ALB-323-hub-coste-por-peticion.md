# ALB-323 · Hub: coste O(N) por petición en búsquedas y cuotas

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-323
- **Rama:** `info/alb-323-m8-hub-coste-on-por-peticion-en-busquedas-y`
- **Prioridad:** Medium
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.

## El problema

Dos cosas que el hub hace en cada petición recorren el directorio entero:

1. **Buscar.** Cada búsqueda de agentes o de topics monta la ficha de **todos** y trocea el texto de todos para puntuarlos.
2. **Comprobar una cuota.** Contar los topics o los agentes de una cuenta recorre todos los topics o todos los agentes.

Se permiten 120 búsquedas por minuto y por red. En un hub grande, quien busca sin parar le hace gastar CPU en proporción al tamaño del directorio.

## Lo que se propone

El issue da dos caminos: índices que el almacén mantiene al día operación a operación, o guardar lo calculado y rehacerlo cuando cambie el directorio. Este plan elige **el segundo**, a falta de que el dueño diga otra cosa:

- Es mucho menos código, y no puede desviarse: se rehace entero a partir del estado, nunca se parchea.
- Un índice mantenido a mano en cada operación que toca una delegación o el dueño de un topic se rompe en silencio el día que alguien añade una operación y se olvida. Aquí lo que se rompería es lo que se cobra.
- El directorio cambia mucho menos de lo que se busca. Lo que hoy se paga en cada búsqueda pasa a pagarse una vez por cambio.

## Cambios

### 1. El almacén dice cuándo cambió el directorio (`src/hub/store.mjs`)

`directoryRev`: un contador que sube con cada operación, **salvo** con una lista corta de las que nunca tocan el directorio (publicar, enviar, confirmar el buzón, lo que se retransmite de MLS). La lista es de las que no cuentan, y no al revés: una operación nueva lo sube mientras nadie diga lo contrario, y lo peor que pasa es rehacer de más.

### 2. Buscar sobre un índice preparado (`src/core/search.mjs`)

- `index(docs)` prepara el corpus una vez: las palabras de cada documento y en qué documentos sale cada una.
- Su `rank(query, extra)` puntúa mirando solo los documentos donde salen las palabras de la consulta. `extra` son los pocos resultados que llegan de otros hubs, que se puntúan junto a los propios, como hoy.
- `rank(query, docs)`, la función de hoy, se queda con su firma.
- **Mismos resultados y mismo orden que hoy.** Es la condición del cambio, y un test la fija.

### 3. El hub guarda lo preparado (`src/hub/server.mjs`)

Una sola memoria, que se rehace cuando `directoryRev` ha cambiado:

- el índice de agentes que se pueden encontrar (activos y sin suspender) y el de topics;
- los agentes agrupados por quien firma su delegación, y los topics por su dueño.

**Las fichas no se guardan.** Llevan cosas que cambian sin que cambie el directorio (el nivel, que depende de si la delegación ha caducado; cuántos siguen un topic). Se montan solo para los resultados que se devuelven, que son 50 como mucho.

**Las cuotas** cuentan sobre los agentes de esa cuenta, no sobre todos, y siguen mirando la hora: una delegación que caduca cambia la cuenta sin que haya ninguna operación.

## Tests

En `test/core.test.mjs`:

1. **El índice da lo mismo que la función de hoy:** con un corpus y un lote de consultas fijos, los mismos documentos, en el mismo orden y con la misma puntuación. También con documentos de fuera añadidos.

En `test/hub.test.mjs` y `test/quotas.test.mjs`:

2. **No se rehace si el directorio no cambió:** cien eventos publicados y dos búsquedas, una sola preparación.
3. **Se rehace cuando cambia:** un agente recién registrado sale en la búsqueda siguiente; uno suspendido deja de salir en el acto; uno retirado, también.
4. **Lo que cambia con el tiempo se ve sin rehacer nada:** con el reloj adelantado, una delegación caducada baja el nivel en la ficha y saca a ese agente de la cuenta de su controlador.
5. **Las cuotas cuentan lo mismo que antes,** con cuentas de varios agentes y varios topics.
6. Los tests de búsqueda entre hubs (`test/federation.test.mjs`) siguen pasando sin tocarlos.

## Medir

Un guion en `experiments/`, con su README: una búsqueda y una comprobación de cuota sobre directorios de mil, diez mil y cien mil agentes, antes y después. La tabla va también al HANDOFF.

## Documentación

- `docs/HANDOFF.md`: sección nueva con la elección, su porqué y las medidas.
- `README.md` y `CLAUDE.md`: número de tests.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`.

## Fuera de este issue

- **Índices mantenidos operación a operación:** si las medidas dicen que rehacer por cambio no basta, se abre entonces.
- **Búsqueda semántica:** `core/search.mjs` ya dice que es un sustituto provisional.
- **Partir `server.mjs`:** ALB-325. Este cambio no lo necesita.
