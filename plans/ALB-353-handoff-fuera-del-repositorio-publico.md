# ALB-353 · Apartar las notas internas de la documentación pública

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-353
- **Rama:** `info/alb-353-apartar-las-notas-internas-handoff-claude`
- **Prioridad:** Low
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada cambiado.

## El problema

`docs/HANDOFF.md` tiene 1.456 líneas en las que se mezclan dos cosas distintas: las decisiones de diseño del protocolo, que explican por qué el código es como es, y notas de trabajo y de operativa (dónde está desplegada la landing, el DNS, las decisiones del dueño sobre el servicio). En un repositorio público, lo segundo sobra, y lo primero se pierde dentro.

`CLAUDE.md` y `AGENTS.md` son notas para los agentes que trabajan en el repositorio. Tienen que seguir en la raíz: las herramientas los leen ahí.

## Decisión del dueño

**El HANDOFF sale del repositorio público.** Pasa entero al repositorio privado. Aquí queda un resumen de las decisiones de diseño.

## Lo que hay que saber antes

- **Quitarlo no lo despublica.** El repositorio ya es público, y el HANDOFF sigue en su historial: quien quiera leerlo, puede. Este cambio lo aparta de la vista y de la documentación; no borra lo publicado. Reescribir el historial sería otra decisión, con sus costes, y este plan no la propone.
- **`CLAUDE.md` manda leerlo antes de cambiar nada,** y nueve de sus reglas remiten a una sección suya. Si sale sin dejar nada en su sitio, quien trabaje aquí, persona o agente, pierde el porqué de cada regla. Por eso el resumen no es opcional.
- **Casi todos los demás planes de este proyecto dicen «sección nueva en `docs/HANDOFF.md`».** Hecho este issue, eso pasa a ser: la decisión de diseño, al documento público de abajo; lo operativo, al HANDOFF del repositorio privado.

## Cómo queda

| Dónde | Qué |
|---|---|
| **Repositorio privado** | El HANDOFF entero, tal cual, con su historia. Sigue creciendo allí |
| **`docs/DECISIONS.md`, aquí** | Las decisiones de diseño del protocolo y del código: qué se decidió, por qué, qué garantiza y qué no. Sin operativa, sin proveedores, sin el proceso de trabajo |
| **`CLAUDE.md` y `AGENTS.md`, en la raíz** | Donde están, diciendo arriba lo que son: notas para quien trabaja en el repositorio, no documentación de uso |

### Qué entra en `docs/DECISIONS.md`

Lo que explica el código de este repositorio: agente e instancia; MLS en los mensajes directos, la renovación de claves y los topics privados; la federación; el registro de transparencia, su mapa y los testigos; la tarjeta de A2A y el registro de OASF; el relevo; las dependencias. Y las limitaciones conocidas.

**Las secciones conservan su número,** aunque queden huecos: las reglas de `CLAUDE.md` que dicen «sección 14» o «sección 33» siguen apuntando a su sitio sin tocarlas más que en el nombre del fichero.

### Qué no entra

Lo del servicio alojado; el despliegue de la landing, su proveedor y su DNS; el relato de cada sesión de trabajo; y lo que el dueño decidió sobre su forma de trabajar.

**El criterio, para los casos dudosos:** si alguien que monta su propio hub o escribe un cliente lo necesita para entender por qué algo es así, entra. Si solo le sirve a quien opera el proyecto, no.

## Pasos

Un commit cada uno.

1. **Escribir `docs/DECISIONS.md`** a partir del HANDOFF, sección a sección, recortando. No se reescriben las decisiones: se quita lo que no lo es.
2. **Llevar el HANDOFF al repositorio privado.** Lo hace el dueño, o una sesión con acceso a ese repositorio.
3. **Quitar `docs/HANDOFF.md` de aquí** y cambiar lo que apuntaba a él: `CLAUDE.md` (once menciones), `README.md` (cuatro), `AGENTS.md` y el README de las mutaciones.
4. **Marcar `CLAUDE.md` y `AGENTS.md`** con una línea arriba que dice lo que son.

## Tests

En `test/package.test.mjs`:

1. **Ningún enlace interno roto:** nada en el repositorio apunta a `docs/HANDOFF.md`.
2. **Cada sección que nombra `CLAUDE.md`** existe en `docs/DECISIONS.md`.
3. **Nada operativo en lo público:** una lista corta de palabras que no deben aparecer en `docs/` ni en el README (nombres de proveedor, por ejemplo). Es un test tosco a propósito: no entiende el texto, pero evita que vuelva por descuido.

## Comprobación

- `npm test`.
- **Leer `docs/DECISIONS.md` entero** con una pregunta: ¿hay aquí algo que no querría ver publicado? Lo hace el dueño; es quien sabe qué es operativa.

## Documentación

- `CLAUDE.md`: «antes de cambiar nada, lee `docs/DECISIONS.md`», y la estructura.
- `README.md`: el enlace a las decisiones de diseño.

## Fuera de este issue

- **Reescribir el historial de git** para borrar lo ya publicado.
- **Un roadmap público:** el issue lo deja como opcional. La lista de lo que falta ya está en el README y en `docs/REFERENCIA.md` (ALB-348).
- **Traducir las decisiones al inglés.**
