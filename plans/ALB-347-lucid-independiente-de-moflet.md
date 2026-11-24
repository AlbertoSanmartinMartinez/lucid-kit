# ALB-347 · La relación comercial entre LUCID y Moflet

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-347
- **Rama:** `info/alb-347-decidir-la-relacion-comercial-entre-lucid-y`
- **Prioridad:** Medium
- **Estado:** decidido el 24 de noviembre de 2026. Nada cambiado todavía.

## De qué va

Es un issue de decisión. LUCID y Moflet son del mismo fundador y hoy no se mencionan entre sí. El nivel «Hosted, for companies» de uselucid.org promete lo mismo que vende Moflet (inicio de sesión único, auditoría, políticas, residencia de datos, soporte con SLA): dos ofertas que pueden competir por el mismo comprador.

## Decisión del dueño

| Pregunta | Decisión |
|---|---|
| Opción A (LUCID es un proyecto abierto de Moflet) u opción B (LUCID es independiente) | **B: LUCID es independiente** |
| Qué pasa con el nivel de empresa de uselucid.org | **Se queda, aclarando que no es Moflet** |

El análisis de producto recomendaba la A. La elección es del dueño, y es la B.

## Lo que se sigue de la decisión

| Qué | Cómo queda |
|---|---|
| El nombre | Todo pasa de «Agent Hub» a LUCID. Ya está decidido y planificado en ALB-346, y es lo que pide la opción B |
| El nivel de empresa en la web | Sigue anunciado como algo futuro de LUCID, con una frase que lo separa de Moflet |
| El contacto | Sigue donde está. Una dirección del dominio del proyecto sería más coherente con «independiente»: se cambia cuando el dueño la tenga |
| Moflet en el repositorio | Sigue sin aparecer en el código ni en el README |

## Cambios

En la landing, en sus dos lenguas, que tienen que decir lo mismo (`site/index.html` y `site/es/index.html`).

### 1. La fila «Hosted, for companies»

Una frase más, al final. El texto exacto lo aprueba el dueño al revisar el cambio; hay dos maneras de escribirla:

- **Nombrando a Moflet** (la que sigue al pie de la letra lo decidido): *«LUCID is an independent project: this service will be its own, and is not Moflet AI's AgentHub.»*
- **Sin nombrarla:** *«LUCID is an independent project, and this service will be its own.»* Aclara menos a quien conoce las dos, pero no pone el nombre de Moflet en la web de LUCID.

### 2. Una línea en el pie

Que LUCID es un proyecto independiente, junto al contacto.

No se toca nada más de la tabla en este issue: si lo que promete cada nivel está comprobado o no es ALB-350.

## Tests

`test/site.test.mjs` ya mantiene las dos páginas iguales entre sí y comprueba sus enlaces de contacto. Se añade que la frase nueva está en las dos.

## Documentación

- `docs/HANDOFF.md`: sección nueva con la decisión, lo que se descartó y lo que se sigue de ella.
- **En el issue de Linear:** la decisión, escrita. Es su primer criterio de aceptación.

## Comprobación

- `npm test`, por `test/site.test.mjs`.
- Mirar las dos páginas en un navegador, en ancho de móvil y de escritorio: la fila nueva no rompe la tabla.

## Fuera de este issue

- **Publicar la landing:** se despliega como siempre, cuando el dueño lo decida.
- **Ajustar lo que la web promete a lo que está comprobado:** ALB-350.
- **La lista de espera:** ALB-356.
- **Qué hace Moflet con LUCID** (integrarlo o no en AgentHub): es de Moflet, no de este repositorio.
