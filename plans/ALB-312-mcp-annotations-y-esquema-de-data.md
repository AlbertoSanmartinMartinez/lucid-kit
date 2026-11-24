# ALB-312 · MCP: `annotations` y un esquema para `data` en las herramientas

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-312
- **Rama:** `info/alb-312-mcp-anadir-annotations-outputschema-y-esquema`
- **Prioridad:** Low
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.

## El problema

El servidor MCP funciona con el cliente oficial y con el Inspector, pero le faltan datos que los clientes de hoy usan:

1. **Ninguna herramienta dice si lee o escribe** (`annotations`). Claude Code, Claude Desktop y Cursor lo usan para decidir cuándo pedir confirmación.
2. **`data`, en `hub_publish` y `hub_send`, no tiene esquema:** solo una descripción. El Inspector lo avisa en su modo estricto.
3. **No hay `outputSchema` ni `structuredContent`:** todo vuelve como texto. El issue lo marca como opcional.

## Lo que se propone

Los dos primeros puntos. **El tercero se deja fuera,** y es una decisión de este plan, a falta de que el dueño diga otra cosa: varias herramientas devuelven palabras de otros agentes, que tienen que llegar al modelo envueltas y marcadas como dato (`hub_inbox`, las búsquedas). Un resultado estructurado sería un segundo camino por el que esas palabras podrían llegar sin su envoltorio. Hacerlo bien pide pensarlo herramienta a herramienta, y el issue no lo exige.

## Cambios

Todos en `src/mcp/server.mjs`.

### 1. `annotations` en las doce herramientas

| Herramienta | Solo lee | Puede quitar algo | Repetirla da lo mismo |
|---|---|---|---|
| `hub_status` | Sí | | |
| `hub_search_topics`, `hub_search_agents`, `hub_get_topic` | Sí | | |
| `hub_register` | No | No | Sí |
| `hub_create_topic` | No | No | No |
| `hub_topic_members` | No | Sí: puede sacar a un miembro | Sí |
| `hub_subscribe`, `hub_unsubscribe` | No | No | Sí |
| `hub_publish`, `hub_send` | No | No | No: cada llamada es un envío nuevo |
| `hub_inbox` | No: leer confirma los mensajes | No | No |

Todas hablan con un hub, que es un sistema de fuera: `openWorldHint` en todas.

`hub_inbox` no es de solo lectura aunque lo parezca, y es la que más importa acertar: un cliente que la creyera inofensiva podría llamarla por su cuenta y consumir el buzón.

### 2. Un esquema para `data`

En `hub_publish` y `hub_send`, `data` declara que admite cualquier valor de JSON, con los tipos escritos uno a uno. Sigue aceptando lo mismo que hoy: el esquema de verdad de un evento es el del topic, y lo comprueban el SDK y el hub.

## Tests

En `test/mcp.test.mjs`:

1. **Las doce herramientas llevan `annotations`.** Las de solo lectura, `readOnlyHint: true`; las demás, `false`. La lista de cuáles son de solo lectura está escrita en el test: una herramienta nueva sin clasificar lo hace fallar.
2. **`hub_inbox` no es de solo lectura.** Con su propio test, por lo dicho arriba.
3. **`data` tiene esquema,** y el validador del proyecto lo entiende entero (ya hay un test que lo exige de todos los esquemas de las herramientas).
4. **Con `data` de cada tipo** (objeto, lista, texto, número, booleano y nulo), `hub_publish` y `hub_send` siguen aceptándolo.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`, que pasa el cliente oficial de MCP.
- **El Inspector de MCP, a mano,** en modo estricto sobre `tools/list`: cero avisos. El resultado y su versión se anotan en el HANDOFF. No se añade como dependencia.

## Documentación

- `README.md`, en la parte de MCP: qué herramientas escriben, y que el servidor sirve solo por stdio hasta ALB-332. Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva, con el porqué de dejar fuera los resultados estructurados.

## Fuera de este issue

- **`outputSchema` y `structuredContent`,** por lo dicho arriba.
- **El transporte HTTP y la revisión 2026-07-28:** ALB-332.
