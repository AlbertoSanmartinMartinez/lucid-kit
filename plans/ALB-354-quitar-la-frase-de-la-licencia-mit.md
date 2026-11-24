# ALB-354 · Quitar la frase de la licencia MIT

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-354
- **Rama:** `info/alb-354-aclarar-o-quitar-la-frase-de-licencia-mit`
- **Prioridad:** Low
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada cambiado.

## El problema

`LICENSE` y el README dicen que el código publicado antes bajo la licencia MIT sigue disponible bajo MIT para quien lo recibió.

Este repositorio nació ya en la 1.0.0, con su reparto de licencias de hoy. No hay en él ningún código que se publicara antes bajo MIT. Tal como está, la frase invita a preguntar qué parte es MIT, y la respuesta es que ninguna.

## Decisión del dueño

**Nunca se publicó código de este proyecto bajo MIT: la frase se quita.** Las versiones anteriores vivieron en un repositorio privado.

## Cambios

Dos sitios, y son los únicos donde aparece:

| Fichero | Qué se quita |
|---|---|
| `LICENSE` | El último párrafo, de dos líneas |
| `README.md`, al final de «Licencia» | La frase equivalente |

Con ALB-314 (dos paquetes) cada paquete lleva su propio fichero de licencia: ninguno de los dos hereda la frase. Con ALB-348 el README se parte en dos: tampoco pasa a ninguno.

## Tests

En `test/licenses.test.mjs`: `LICENSE` y los README no nombran más licencias que las dos del proyecto, Apache-2.0 y AGPL-3.0-only. Si alguien vuelve a nombrar otra, el test obliga a que sea a propósito.

## Lo que hace el dueño

**Pasarlo por Legal,** que es el primer criterio del issue. Va en la misma revisión que ya está pendiente: el reparto de licencias en dos paquetes (ALB-314) y el DCO (ALB-352). Este plan recoge lo que el dueño afirma, que nunca hubo código MIT publicado; si Legal encontrara algo que lo contradiga, la frase no se quita sino que se precisa, nombrando qué código y dónde.

## Comprobación

- `npm test`.

## Fuera de este issue

- **Las cabeceras de licencia que faltan** en tests, ejemplos y guiones: B1 de ALB-326.
- **El reparto de licencias** entre el cliente y el hub: ALB-314.
