# ALB-328 · npm: metadatos, workflow de release y primera publicación

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-328
- **Rama:** `info/alb-328-npm-metadatos-del-paquete-workflow-de-release`
- **Prioridad:** High
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.

## Antes de este issue

| Issue | Por qué va antes |
|---|---|
| ALB-314 | Se publican dos paquetes, `@uselucid/kit` y `@uselucid/hub`, no `lucid-kit`. Incluye crear la organización `uselucid` en npm y decidir dónde queda el CLI |
| ALB-346 | La descripción del paquete y el comando llevan hoy «Agent Hub» y `agenthub`. Lo que se publica no se puede despublicar: el nombre se decide antes |
| ALB-327, y con él ALB-301 y ALB-302 | La primera versión publicada no debe llevar los fallos del almacén |

## El problema

- Nada está publicado en npm.
- A `package.json` le faltan `repository`, `homepage`, `bugs`, `keywords` y `author`. Sin un `repository.url` que sea el de este repositorio, npm no puede verificar la procedencia.
- No hay workflow de release ni GitHub Release.
- El README que iría en el paquete es el del repositorio: 791 líneas, en español.

## Decisiones del dueño

| Pregunta | Decisión |
|---|---|
| Cómo sale la primera versión | **A mano, desde el ordenador del dueño.** El «trusted publishing» de npm solo se configura en un paquete que ya existe. La primera versión queda sin sello de procedencia; el workflow se estrena en la segunda |
| El README de cada paquete | **Corto y en inglés.** Una excepción a «textos para el usuario en español», limitada a lo que se ve en npm |
| Número de la primera versión | **1.1.0**, en los dos paquetes |

## Cambios

### 1. Metadatos, en los dos `package.json`

```json
"repository": { "type": "git", "url": "git+https://github.com/AlbertoSanmartinMartinez/lucid-kit.git", "directory": "packages/kit" },
"homepage": "https://uselucid.org",
"bugs": "https://github.com/AlbertoSanmartinMartinez/lucid-kit/issues",
"keywords": ["ai-agents", "mcp", "a2a", "mls", "e2ee", "did", "pubsub", "transparency-log"],
"publishConfig": { "access": "public" }
```

- `publishConfig.access` hace falta: un paquete con ámbito se publica privado si no se dice otra cosa.
- `author`: el nombre que el dueño quiera que figure, sin correo.
- `description`: una frase por paquete, con el nombre que salga de ALB-346.

### 2. Un README por paquete

`packages/kit/README.md` y `packages/hub/README.md`, de unas 40 líneas, en inglés: qué es, cómo se instala, un ejemplo mínimo que funciona, la licencia, y enlaces al repositorio y a uselucid.org. El ejemplo de cada uno se ejecuta en un test, para que no se quede viejo.

### 3. `.github/workflows/release.yml`

Se lanza al subir una etiqueta `v*`. Sin secretos: publica con la identidad del propio workflow (OIDC).

| Job | Qué hace |
|---|---|
| `verify` | Lo mismo que la CI: tests con Node 20, 22 y 24, `checks/all.sh` y la imagen. `ci.yml` gana un disparador `workflow_call` para reutilizarlo |
| `publish` | Comprueba que la etiqueta es la versión de los dos paquetes. Publica el kit y después el hub, que depende de él. Una versión que ya está en npm se salta: el job se puede repetir. Permisos: `id-token: write` y nada más. Entorno `npm` de GitHub, que el dueño puede proteger con su aprobación |
| `smoke` | En un directorio vacío instala del registro la versión recién publicada, importa `@uselucid/kit`, pide la ayuda del CLI y pasa `npm audit signatures` |
| `release` | Crea la GitHub Release de la etiqueta con las notas generadas |

Las acciones van fijadas por el SHA de su commit. El workflow usa un npm que sepa publicar así (11.5.1 o posterior).

### 4. La versión

`1.1.0` en los dos paquetes, en `server.json` y en lo que `test/package.test.mjs` ya comprueba que la dice (el hub y el servidor MCP).

## La primera publicación, paso a paso

Lo hace el dueño. Son acciones de fuera y sin vuelta atrás.

1. La CI de `main` está en verde en el commit que se va a publicar.
2. En ese commit, con el árbol limpio: `npm ci`, `npm test`, `bash checks/all.sh`.
3. `npm pack --dry-run` de cada paquete, y mirar la lista de ficheros.
4. `npm publish --workspace packages/kit`, y después `--workspace packages/hub`, con la sesión de npm del dueño y su segundo factor.
5. Etiqueta `v1.1.0` y `git push` de la etiqueta. El workflow corre: `verify`, `publish` ve que las dos versiones ya están y se las salta, `smoke` instala desde el registro y `release` crea la GitHub Release.
6. `npm view @uselucid/kit` y `npm view @uselucid/hub`: repositorio, licencia y versión.

**La segunda versión**, la primera que publica el workflow:

7. En npmjs.com, en cada paquete, se configura el publicador de confianza: este repositorio, `release.yml` y el entorno `npm`. Se hace cuando la versión ya está lista para etiquetar, releyendo antes la documentación de npm: la consultada hoy dice que una configuración nueva tiene pocos días para hacer su primera publicación.
8. Se etiqueta. Se comprueba el sello de procedencia en la página de cada paquete.

## Tests

En `test/package.test.mjs`:

1. **Los metadatos:** `repository.url` es exactamente este repositorio, `directory` es la carpeta de cada paquete y `publishConfig.access` es `public`.
2. **Lo que llevaría cada paquete** incluye su README y su licencia.
3. **El ejemplo de cada README** se ejecuta contra un hub de prueba.
4. **El workflow de release:** solo se dispara con etiquetas, no nombra ningún secreto, `id-token: write` está solo en `publish` y cada acción va fijada por SHA. Se lee como texto, sin dependencia nueva.

## Documentación

- `README.md`: cómo se instala desde npm. Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva con las decisiones, los pasos de una publicación y lo que queda sin verificar.
- `CLAUDE.md`: el workflow de release en «Estructura», y que el README de cada paquete va en inglés.

## Lo que no queda verificado hasta la segunda versión

Que el workflow publique de verdad y que npm muestre el sello de procedencia. Con la primera versión a mano, el criterio del issue «con la etiqueta, el workflow publica con provenance» se cumple en la 1.1.1 o la que venga.

## Fuera de este issue

- **El CHANGELOG:** ALB-326. Hasta entonces, las notas de la release son las que genera GitHub.
- **El registro de MCP:** ALB-329. **El README del repositorio en inglés:** ALB-348.
- **`npx agenthub --help` desde el paquete publicado:** depende de dónde quede el CLI, que se decide en ALB-314.

## Fuentes

- [Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/), consultada el 24 de noviembre de 2026.
- [npm trusted publishing with OIDC is generally available](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/).
