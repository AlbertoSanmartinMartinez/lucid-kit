# ALB-329 · Registro de MCP: nombre del servidor, `server.json` completo y publicación desde CI

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-329
- **Rama:** `info/alb-329-registro-mcp-corregir-las-mayusculas-de-mcpname`
- **Prioridad:** High
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.

## Antes de este issue

| Issue | Por qué va antes |
|---|---|
| ALB-314 | Decide en qué paquete queda la orden `mcp`: a ese apunta la ficha, y en ese va `mcpName` |
| ALB-328 | El registro comprueba quién es el dueño leyendo `mcpName` en el paquete **ya publicado** en npm |

**Ojo con el orden:** los cambios de nombre de este plan (pasos 1 y 2) tienen que estar en el código **antes** de publicar la 1.1.0 en npm. Si la 1.1.0 sale con el `mcpName` viejo, el alta en el registro tendría que esperar a la versión siguiente.

## El problema

- El nombre de hoy, `io.github.albertosanmartinmartinez/agenthub`, va en minúsculas y el usuario de GitHub no: el registro podría rechazarlo. No se ha podido confirmar hoy si ese fallo del registro sigue abierto.
- A `server.json` le faltan `repository` y `websiteUrl`, que es lo que enseña el catálogo.
- No hay nada publicado en el registro, ni paso que lo publique.

## Decisiones del dueño

| Pregunta | Decisión |
|---|---|
| Espacio de nombres | **El dominio propio: `org.uselucid/…`.** No depende de la cuenta personal de GitHub ni de sus mayúsculas |
| Nombre del servidor | **`lucid`**. El servidor es `org.uselucid/lucid` |

Con esto el problema de las mayúsculas desaparece, y la expresión de `test/package.test.mjs` que exige minúsculas se queda como está.

## Cambios

### 1. El nombre

`"mcpName": "org.uselucid/lucid"` en el `package.json` del paquete que lleve la orden `mcp`, y el mismo `name` en `server.json`.

### 2. `server.json`

- `name`, y `title`: «LUCID».
- `repository`: `{ "url": "https://github.com/AlbertoSanmartinMartinez/lucid-kit", "source": "github" }`.
- `websiteUrl`: `https://uselucid.org`.
- `version` y la del paquete: la que se publique. `identifier`: el paquete de npm que lleve la orden.
- El valor por defecto de `AGENTHUB_IDENTITY`, el que deje ALB-305.

### 3. Demostrar que el dominio es nuestro

Lo hace el dueño, una vez:

1. Genera un par de claves para el registro.
2. Pone la pública en un registro TXT del DNS de `uselucid.org`, con el formato que pide el registro.
3. Guarda la privada como secreto del entorno `mcp-registry` de GitHub, protegido con su aprobación. No es un token personal: solo sirve para publicar fichas bajo `org.uselucid/`.

El formato exacto del TXT y de la clave se toma de la [documentación del registro](https://modelcontextprotocol.io/registry/authentication) al implementarlo.

### 4. Un job más en `release.yml`

`mcp-registry`, después de `publish` y `smoke` (ALB-328), en el entorno `mcp-registry`:

1. Baja `mcp-publisher` en una versión fija y comprueba su suma.
2. `mcp-publisher login dns` con el dominio y la clave del secreto.
3. `mcp-publisher publish`.
4. Pregunta al registro por `org.uselucid/lucid` y comprueba que devuelve la versión recién publicada.

El secreto solo se nombra en este job.

## Una regla que ya costó un error

`mcp-publisher validate` no valida en local: envía la ficha al registro (sección 31 de `docs/HANDOFF.md`). No se ejecuta sin que el dueño lo haya pedido. La ficha se valida contra el esquema al publicarla, y el registro la rechaza entera si está mal.

## Tests

En `test/package.test.mjs`:

1. `mcpName` y el `name` de `server.json` son `org.uselucid/lucid`.
2. `server.json` lleva `repository`, con la dirección de este repositorio, y `websiteUrl`.
3. Lo que ya comprueba: una sola entrada de paquete, las versiones iguales, la descripción de 100 caracteres como mucho, y que los valores por defecto de la ficha son los del CLI.
4. En `release.yml`: el job del registro va después del de npm, `mcp-publisher` está fijado a una versión con su suma, y el secreto no aparece en ningún otro job.

## Comprobación, al publicar

- `GET https://registry.modelcontextprotocol.io/v0/servers?search=org.uselucid/lucid` devuelve el servidor con la versión publicada: lo hace el último paso del job.
- Instalar el servidor desde el registro en un cliente de MCP y ver que arranca: a mano, junto a las pruebas de ALB-305.

## Documentación

- `README.md`: el servidor está en el registro de MCP y cómo se llama.
- `docs/HANDOFF.md`: sección nueva; la lista de pendientes de la 31 queda cerrada.
- `CLAUDE.md`: `server.json` deja de ser «sin publicar», y `mcp-publisher validate` no se usa sin permiso.

## Lo que no queda verificado hasta publicar

Que el registro acepte la demostración por DNS y la ficha. Solo se sabe al hacerlo, y es una acción hacia fuera que aprueba el dueño.

## Fuera de este issue

- **El servidor alojado por HTTP (`remotes` en `server.json`):** ALB-332.
- **Un comando de MCP solo con código Apache** (B2 de ALB-326): es la decisión del CLI de ALB-314.
- **El nombre del comando y de las variables (`agenthub`, `AGENTHUB_*`):** ALB-346.
