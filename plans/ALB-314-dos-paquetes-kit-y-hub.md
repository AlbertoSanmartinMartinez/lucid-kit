# ALB-314 · Empaquetado: dos paquetes, `@uselucid/kit` (Apache-2.0) y `@uselucid/hub` (AGPL-3.0-only)

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-314
- **Rama:** `info/alb-314-a4-empaquetado-un-solo-paquete-npm-mezcla-el`
- **Prioridad:** High. Bloquea ALB-328 (la primera publicación en npm).
- **Estado:** plan del 24 de noviembre de 2026, con **una decisión pendiente** (el CLI). Nada implementado.

## El problema

Un solo paquete, `lucid-kit`, lleva el lado cliente (Apache-2.0) y el hub (AGPL-3.0-only):

1. **Su licencia es `Apache-2.0 AND AGPL-3.0-only`.** Los escáneres de licencias y muchas políticas de empresa marcan el paquete entero, aunque nadie importe el hub.
2. **No tiene `exports` ni punto de entrada.** `import 'lucid-kit'` falla, y `import 'lucid-kit/src/hub/server.mjs'` funciona sin ninguna barrera.
3. **Cada fichero de `src/` es interfaz pública de hecho.**

## Decisiones del dueño

| Pregunta | Decisión |
|---|---|
| Un paquete con `exports` o dos paquetes | **Dos paquetes ya**, antes de publicar nada en npm: partir un paquete publicado es más caro |
| Nombres | **`@uselucid/kit`** (cliente) y **`@uselucid/hub`** (servidor) |
| Cómo instala el servicio alojado | **Desde npm**, cuando exista la primera publicación (ALB-328). Hasta entonces sigue en `lucid-kit#v1.0.0`. npm no sabe instalar una subcarpeta de un repositorio de GitHub |
| Dónde queda el CLI | **Pendiente.** Opciones abajo |
| Qué importa hoy el servicio alojado | **Sin confirmar.** Es el primer paso del plan |

Esto sustituye a lo acordado en la sección 37 de `docs/HANDOFF.md` (sin `exports`, instalación desde una etiqueta).

## Cómo queda el repositorio

```
package.json          privado, "workspaces": ["packages/*"]; npm test y npm run demo, como hoy
packages/kit/         @uselucid/kit · Apache-2.0
  package.json  LICENSE
  src/core  src/mls  src/sdk  src/mcp
packages/hub/         @uselucid/hub · AGPL-3.0-only · depende de @uselucid/kit
  package.json  LICENSE
  src/hub  src/verifier  src/witness
test/  checks/  examples/  experiments/  site/  docs/  deploy/     donde están
```

Las carpetas se mueven enteras con `git mv`. Ningún fichero se renombra ni se parte.

### `@uselucid/kit`

- `"license": "Apache-2.0"`. Dependencias: `ts-mls` y `@noble/hashes`, con versión exacta, como hoy.
- Dentro del paquete las rutas son las de hoy (`src/core/…`): para el servicio alojado solo cambia el nombre del paquete en sus imports.

```json
"exports": {
  ".": "./src/sdk/index.mjs",
  "./mcp": "./src/mcp/server.mjs",
  "./src/core/*": "./src/core/*",
  "./src/mls/*": "./src/mls/*",
  "./src/sdk/*": "./src/sdk/*",
  "./src/mcp/*": "./src/mcp/*",
  "./package.json": "./package.json"
}
```

### `@uselucid/hub`

- `"license": "AGPL-3.0-only"`. Una dependencia: `@uselucid/kit`, en la misma versión exacta.
- Sus ficheros importan el kit por su nombre (`from '@uselucid/kit/src/core/didweb.mjs'`): son 38 líneas en 6 ficheros. En el otro sentido no hay ninguna, y `test/licenses.test.mjs` ya lo vigila.
- `exports`: `"."` (el hub), `"./witness"`, `"./verifier"` y `"./package.json"`. Si el servicio alojado importa algo más del hub, se añade en el paso 0.

### Versiones

Los dos paquetes llevan la misma versión y se mueven juntos. Ninguno tiene scripts que se ejecuten al instalarlo.

## La decisión pendiente: el CLI

Hoy hay un comando, `agenthub` (`bin/agenthub.mjs`), con licencia AGPL porque también arranca el hub. Hay que decidir antes del paso 2:

| Opción | Qué supone |
|---|---|
| **Dos comandos** (la que recomienda este plan) | `agenthub` se queda en el kit con las órdenes de agente, de controlador y `mcp`, y pasa a Apache-2.0. `hub`, `witness` y `verifier` pasan a un comando propio en `@uselucid/hub`. Quien hace agentes no instala nada AGPL. Cambian la documentación, los guiones de `checks/`, el `Dockerfile` y `deploy/` donde dicen `agenthub hub` |
| Un comando que delega | `agenthub` vive en el kit y `agenthub hub\|witness\|verifier` carga `@uselucid/hub` si está instalado. Las órdenes de hoy no cambian; a cambio el CLI carga otro paquete en marcha |
| Todo el CLI en `@uselucid/hub` | El menor cambio. Para lanzar el servidor MCP o registrar un agente desde la terminal hay que instalar el paquete AGPL |

De esta decisión dependen: dónde va `bin/`, a qué paquete apuntan `server.json` y `mcpName`, el `.mcp.json` del repositorio, la entrada del `Dockerfile` y las órdenes de `deploy/` y `checks/`.

## Pasos

Un commit por paso, con `npm test` en verde en cada uno.

**0. Antes de tocar nada**

- Crear la organización `uselucid` en npm (el dueño). Hoy no hay nada publicado bajo ese ámbito; si el nombre está libre solo se sabe al crearla. Si no lo está, se vuelve a decidir el nombre.
- Listar lo que el servicio alojado importa de `lucid-kit`, en su repositorio:
  `grep -rhoE "lucid-kit/[A-Za-z0-9_./-]+" --include='*.mjs' --include='*.js' --include='*.ts' . | sort -u`
  Lo que salga tiene que quedar cubierto por los `exports` de arriba, o se ajustan.
- Decidir el CLI.

**1. Workspaces y mudanza**

- `package.json` de la raíz privado y con `workspaces`; los dos `package.json` nuevos y sus `LICENSE`.
- `git mv` de las siete carpetas de `src/`.
- Los imports del hub hacia el kit, por nombre.
- Las rutas en lo que apunta a `src/` o a `bin/`: 31 ficheros de `test/`, 7 de `experiments/` (los guiones de mutaciones cambian el código en sitio), 8 de `checks/`, `examples/`, `site/tools/`, el `Dockerfile`, `.mcp.json` y la CI.
- `npm install` para rehacer el fichero de bloqueo, que sigue siendo uno, en la raíz.

**2. El CLI**, según lo decidido.

**3. Los tests del empaquetado** (abajo).

**4. `server.json` y `mcpName`**, en el paquete que lleve la orden `mcp`.

**5. Documentación** (abajo).

## Tests

`test/package.test.mjs`, rehecho para dos paquetes:

1. **Qué llevaría cada paquete** (`npm pack --dry-run`): el kit, solo `src/core`, `src/mls`, `src/sdk`, `src/mcp` y su licencia; el hub, solo `src/hub`, `src/verifier`, `src/witness` y la suya. Nada del resto del repositorio.
2. **Ningún fichero AGPL en el kit:** cada `.mjs` que llevaría dice `SPDX-License-Identifier: Apache-2.0`. Y al revés en el hub.
3. **`import '@uselucid/kit'` es el SDK.**
4. **El mapa de `exports`:** cada fichero de `src/core`, `src/mls` y `src/sdk` se resuelve por su ruta, con la lista del paso 0 escrita en el test; `@uselucid/kit/src/hub/…` no existe.
5. **El kit no depende del hub** ni importa nada de fuera de su paquete. El hub depende del kit en su misma versión exacta.
6. **Las dos versiones son la misma**, y ninguno tiene scripts de instalación.
7. Lo que ya comprueba hoy: la ficha del registro de MCP y que el hub y el servidor MCP dicen la versión del paquete.

`test/licenses.test.mjs` sigue: cabecera SPDX en cada fichero y el cliente sin imports del hub.

`checks/packages.sh`, nuevo, con procesos de verdad y dentro de `all.sh`: empaqueta los dos, los instala en un proyecto vacío y comprueba lo que el issue probó a mano: que `import '@uselucid/kit'` funciona, que instalar solo el kit no trae ningún fichero AGPL, y que el hub arranca desde el paquete instalado.

## Documentación

- `README.md`: cómo se instala cada paquete, los imports y la tabla de licencias. El `LICENSE` de la raíz explica los dos paquetes.
- `CLAUDE.md`: «Estructura», el párrafo del servicio alojado (ya no vale «sin `exports`» ni «desde una etiqueta») y «Licencias».
- `docs/HANDOFF.md`: sección nueva con las decisiones, que sustituye a lo dicho en la 37.
- `docs/SELF-HOSTING.md`, `checks/README.md`, los README de `experiments/` y `site/README.md`, donde nombran rutas u órdenes.

## Comprobación

- `npm test` y `npm run demo`.
- `bash checks/all.sh`, con `packages.sh` dentro, y `checks/self-hosted.sh` para la imagen del hub.
- Los guiones de `experiments/mutations/`, que dependen de las rutas: todas las mutaciones siguen cazadas.

## Lo que rompe, y a quién

- **Al servicio alojado:** el nombre del paquete en sus imports y de dónde lo instala. Sigue en `v1.0.0` hasta que haya publicación.
- **A las comprobaciones de versiones** (`upgrade.sh`, `mixed-hubs.sh`, `mixed-clients.sh`): el árbol de la versión anterior tiene el CLI en otro sitio, y `checks/lib.sh` tiene que saber dónde está en cada uno.
- **A nadie más que se sepa:** `lucid-kit` nunca llegó a npm.

## Fuera de este issue

- **Publicar en npm:** ALB-328. **El registro de MCP:** ALB-329.
- **Tipos y `.d.ts`:** ALB-324.
- **Estrechar lo público del kit.** `src/core/*` sigue abierto por ruta porque el servicio alojado lo usa así; partir `sdk/index.mjs` es ALB-325.
- **El nombre «Agent Hub» y el comando `agenthub`:** ALB-346.
- **Qué número de versión lleva el cambio:** lo decide el dueño al etiquetar.
