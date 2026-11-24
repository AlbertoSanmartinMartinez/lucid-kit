# ALB-305 · MCP: la ruta relativa de la identidad hace fallar el arranque con `cwd /`

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-305
- **Rama:** `info/alb-305-mcp-la-ruta-relativa-de-la-identidad-hace`
- **Prioridad:** High
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.

## El problema

La identidad por defecto es `./.agenthub/identity.json`, relativa al directorio desde el que se lanza el proceso. Varios clientes de MCP lanzan el servidor en `/`: `agenthub mcp` intenta crear `/.agenthub`, falla con `EACCES` y termina antes de contestar a `initialize`. El cliente solo ve que el servidor se desconectó.

Además, el mismo agente lanzado desde dos directorios es dos agentes distintos, sin que nada lo diga. `server.json` publica esa misma ruta relativa.

## Decisiones del dueño

| Pregunta | Decisión |
|---|---|
| Dónde vive la identidad por defecto | **`~/.agenthub/` para todo el CLI:** identidad, controlador y guardián. Una sola regla, se lance desde donde se lance. Quien usaba el valor por defecto dentro de un proyecto pasa `--identity` o mueve el fichero |
| Con qué otros clientes se prueba | **Codex, Cursor y Claude Code, a mano**, cuando se implemente el plan |

## Cambios

### 1. `bin/agenthub.mjs`

- **Los tres valores por defecto** pasan a `~/.agenthub/identity.json`, `~/.agenthub/controller.json` y `~/.agenthub/guardian.json`. El estado de MLS sigue junto a la identidad (`<identidad>.state`).
- **Una ruta que empieza por `~/`** se resuelve contra el directorio del usuario, venga del valor por defecto, de `--identity` o de `AGENTHUB_IDENTITY`. Los clientes de MCP pasan las variables tal cual, sin expandir `~`: sin esto, quien lo escriba en su configuración crearía un directorio llamado `~`.

  ```js
  // A path that starts with "~/" is under the home of whoever runs this, wherever it is run from.
  const fromHome = (file) => (file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file);
  const identityFile = () => fromHome(opts.identity ?? process.env.AGENTHUB_IDENTITY ?? '~/.agenthub/identity.json');
  ```

- **El texto de ayuda** (las tres líneas que nombran la ruta).
- **Si la identidad no se puede crear o leer**, el error dice qué fichero y qué hacer, sin traza, y sale con 1 como los demás errores del CLI: `error: cannot write the identity to <ruta> (<código>): set AGENTHUB_IDENTITY, or --identity, to a file this user can write`. En `mcp` va por la salida de errores; por la estándar no sale nada.
- **Un aviso, una línea por la salida de errores**, cuando no se dio ninguna ruta, en el directorio actual hay un `./.agenthub/identity.json` y en `~/.agenthub/` no hay identidad: dice que ese fichero ya no se usa por defecto y cómo seguir con él (`--identity ./.agenthub/identity.json`, o moverlo). No es una regla de precedencia: el fichero no se usa. Evita que alguien pase a ser otro agente al actualizar sin enterarse.

### 2. `server.json`

`AGENTHUB_IDENTITY` pasa a `"default": "~/.agenthub/identity.json"`. `test/package.test.mjs` ya comprueba que los valores por defecto de la ficha son los del CLI.

### 3. `.mcp.json` del repositorio

No cambia: nombra a propósito un fichero del proyecto (`.agenthub/claude-code.json`), y Claude Code arranca en su raíz.

## Tests

En `test/mcp.test.mjs`, con el proceso de verdad y `HOME` apuntando a un directorio temporal (`os.homedir()` lo respeta):

1. **Arranque con un directorio de trabajo donde no se puede escribir:** sin `AGENTHUB_IDENTITY`, contesta a `initialize`, la identidad queda en `$HOME/.agenthub/identity.json` y en el directorio de trabajo no se crea nada. El directorio es uno de solo lectura, no `/`: los tests pueden correr como root, que sí escribe en `/`.
2. **Lanzado desde dos directorios distintos**, es el mismo agente (el mismo DID).
3. **`AGENTHUB_IDENTITY=~/otro/agente.json`** se resuelve contra el directorio del usuario.
4. **Un directorio de usuario donde no se puede crear nada** (`HOME` es un fichero): mensaje claro por la salida de errores, salida 1, nada por la estándar y ninguna traza.
5. **El aviso** sale cuando hay un `./.agenthub/identity.json` sin usar, y no sale si se dio `--identity` o la variable.

`test/package.test.mjs` sigue pasando con la ficha nueva.

## Prueba manual, al implementarlo

Con el hub en marcha y el servidor registrado en cada cliente **sin** `AGENTHUB_IDENTITY`:

| Cliente | Qué se mira |
|---|---|
| Codex | El servidor conecta, lista sus herramientas y `hub_status` contesta. La identidad está en `~/.agenthub/identity.json` |
| Cursor | Lo mismo |
| Claude Code | Lo mismo, lanzado desde dos proyectos distintos: el mismo DID |

Cómo se registra un servidor MCP en Codex y en Cursor se toma de su documentación en ese momento. El resultado va al README con la versión de cada cliente y el día.

## Documentación

- `README.md`: la ruta por defecto nueva en el CLI y en la sección de MCP; cómo registrar el servidor en Codex y en Cursor; y «Sin comprobar: otros clientes MCP» pasa a decir cuáles se comprobaron, con qué versión y cuándo, y cuáles no. Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva con la decisión y el cambio incompatible.
- Notas de la versión: la identidad por defecto cambia de sitio.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`: sus guiones dan siempre la ruta de la identidad, así que no deberían notar el cambio; se pasa para confirmarlo.

## Fuera de este issue

- **Claude Desktop**, que es el cliente del que habla el issue: no está entre los tres que se prueban. El test 1 cubre su caso (el directorio de trabajo), y el README lo deja como no comprobado.
- **Un directorio de configuración por sistema** (`XDG_CONFIG_HOME`, `%APPDATA%`): `~/.agenthub/` en todos.
- **Publicar la ficha en el registro de MCP:** ALB-329.
