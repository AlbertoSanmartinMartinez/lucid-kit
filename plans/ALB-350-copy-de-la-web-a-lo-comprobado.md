# ALB-350 · Ajustar los textos de uselucid.org a lo que está comprobado

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-350
- **Rama:** `info/alb-350-ajustar-el-copy-de-uselucidorg-a-lo-que-esta`
- **Prioridad:** Medium
- **Estado:** plan del 24 de noviembre de 2026. Nada cambiado.

## El problema

Varias frases de la web van por delante de lo que está probado en el repositorio. En un proyecto que se presenta por la confianza, eso cuesta más que en otros. Y una de ellas se contradice dentro de la misma página.

## Lo que se propone

El issue deja elegir, frase por frase, entre ajustar el texto o cerrar antes el hueco. Este plan **ajusta el texto ahora** en las cinco: es barato y deja la web diciendo la verdad desde ya. Cerrar cada hueco tiene su propio issue, y cuando se cierre la frase vuelve a subir.

Los textos de abajo son una propuesta. Es la voz del proyecto hacia fuera: **la redacción final la aprueba el dueño** al revisar el cambio.

## Las cinco frases

| # | Hoy dice | Qué es verdad | Propuesta | Vuelve a subir con |
|---|---|---|---|---|
| 1 | «…so Claude Code **or any MCP client** can use a hub as a set of tools.» | Probado con Claude Code y con el SDK oficial de MCP | «…tested with Claude Code and the official MCP SDK. Other MCP clients should work and are not verified yet.» | ALB-305, que prueba Codex y Cursor a mano |
| 2 | «An agent can also be listed in the **AGNTCY directory** as an OASF record.» | El registro OASF se genera; no se ha pasado por su validador ni se ha publicado | «An agent can also be exported as an OASF record, the format of the AGNTCY directory. It has not been validated or listed there yet.» | Pasar el validador de OASF |
| 3 | «**Independent witnesses** cosign it…», y más abajo: «Not there yet: a network of independent witnesses» | El servidor del testigo existe y está probado; no hay red de testigos | «A witness server is included, so that others can cosign the log. There is no public network of witnesses yet.» Las dos menciones dicen lo mismo | Que exista esa red |
| 4 | «LUCID is an **open protocol**…» (tres veces: la descripción, la cabecera y el pie) | No hay una especificación aparte de la implementación | «LUCID is open source: a protocol and its implementation for agents to…» | ALB-351, la especificación |
| 5 | En `docs/SELF-HOSTING.md`: «Es el mismo código que usa el servicio alojado» | No hay servicio alojado | «Es el mismo código que usará el servicio alojado, que todavía no existe» | El servicio alojado |

Los huecos de `did:web` y del verificador de GitHub tienen sus issues (ALB-330, ALB-331, ALB-333) y no se repiten aquí.

Una sexta, que no está en el issue y sale de otro plan: la web dice que los tests corren «on Node 20, 22 and 24». Con ALB-313 serán 22, 24 y 26: se cambia cuando ese issue esté hecho, no antes.

## Cambios

- `site/index.html` y `site/es/index.html`: las frases 1 a 4, en las dos lenguas, que tienen que decir lo mismo.
- `docs/SELF-HOSTING.md`: la frase 5.

Solo texto. Lo que la página enseña como bytes del protocolo y sus ilustraciones lo generan `site/tools/`, y no se toca.

## Tests

En `test/site.test.mjs`, que ya mantiene iguales las dos páginas:

1. **Las frases retiradas no están** en ninguna de las dos: «any MCP client», «listed in the AGNTCY directory», «Independent witnesses cosign».
2. **La página no se contradice sobre los testigos:** las dos menciones dicen que no hay red pública.

Un test no puede saber si una frase es verdad. Lo que sí hace es que una frase retirada a propósito no vuelva sin que alguien cambie el test, y eso se ve en la revisión.

## Documentación

- `docs/HANDOFF.md`: sección nueva con la tabla, para que quien cierre un hueco sepa qué frase le toca subir.
- `CLAUDE.md`, regla «Honestidad en la documentación»: vale también para la landing.

## Comprobación

- `npm test`, por `test/site.test.mjs`.
- Las dos páginas en un navegador, en ancho de móvil y de escritorio.

## Fuera de este issue

- **Publicar la landing:** se despliega como siempre, cuando el dueño lo decida.
- **El nivel de empresa y su relación con Moflet:** ALB-347.
- **La lista de espera:** ALB-356.
- **Probar un segundo cliente de MCP, validar OASF o montar una red de testigos:** cada uno en su issue, si se decide.
