# ALB-325 · Refactor: partir `hub/server.mjs` y `sdk/index.mjs`, primera parte

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-325
- **Rama:** `info/alb-325-m10-refactor-partir-hubservermjs-3578-lineas-y`
- **Prioridad:** Medium
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.

## El problema

- `src/hub/server.mjs` tiene 3.578 líneas. `createHub` es un solo cierre de unas 3.260, con más de 120 rutas, la federación, MLS, los testigos y el ciclo de vida.
- `src/sdk/index.mjs` tiene 2.567. `AgentClient` ocupa unas 2.160, con unos 150 miembros, casi todos privados.

Nada se puede probar suelto, y cada cambio toca un fichero enorme. Casi todos los demás issues de este proyecto tocan uno de los dos.

## Decisión del dueño

De las nueve fases que propone el issue, **las redes de seguridad y lo puro**: los tests que fijan la interfaz, y lo que se puede mover sin rediseñar nada. Lo demás (un contexto explícito para el hub, las rutas por dominio, un núcleo interno para el cliente) se decide con esto hecho, en issues aparte: es donde está el riesgo.

## Cuándo

**Después de los issues de prioridad alta,** y en concreto de ALB-314 (mueve las carpetas a `packages/`) y ALB-346 (renombra en 80 ficheros). Hacerlo antes sería resolver conflictos en cada uno de ellos.

## La regla de todo el issue

**No cambia el comportamiento.** Cada paso mueve código tal cual, de un fichero a otro, y deja los tests en verde sin tocarlos. Si mover algo obliga a cambiar un test, ese algo no era puro y se queda donde está.

## Pasos

Un commit por paso.

### 0. Las redes de seguridad: `test/surface.test.mjs`, nuevo

Dos listas guardadas en el repositorio, que un test compara con lo que el código dice:

- **Las rutas del hub:** `método ruta autenticación`, una por línea. El hub las enseña con una función de solo lectura, para este test.
- **Lo público del cliente:** lo que exporta `src/sdk/index.mjs`, los métodos públicos de `AgentClient` y los nombres de las herramientas de MCP.

Si un paso del refactor cambia una de las dos sin querer, el test lo dice. Quien las cambia queriendo actualiza la lista en el mismo commit, y eso se ve en la revisión.

Lo que el issue pone también en esta fase y aquí no va: `exports` (hecho de otra forma en ALB-314), ESLint y Prettier (descartados en ALB-313) y los tipos (ALB-324).

### 1. El hub: lo que no depende del estado del hub

| Fichero nuevo | Qué se lleva | Líneas, aprox. |
|---|---|---|
| `src/hub/config.mjs` | Los valores por defecto, los límites y la comprobación de las opciones | 175 |
| `src/hub/http.mjs` | Leer el cuerpo, contestar JSON, `HttpError`, los parámetros de página | 100 |
| `src/hub/validate.mjs` | Las comprobaciones de forma de lo que entra | 100 |

`server.mjs` baja unas 375 líneas e importa de los tres.

### 2. El SDK: las funciones sueltas

Lo que está fuera de la clase `AgentClient`:

| Fichero nuevo | Qué se lleva |
|---|---|
| `src/sdk/errors.mjs` | `HubError` y `LogError` |
| `src/sdk/transport.mjs` | `fetchFromHub` y lo que pide sin cliente |
| `src/sdk/identity-file.mjs` | Guardar y cargar identidades |
| `src/sdk/verification.mjs` | Lo del verificador de cuentas |
| `src/sdk/moderation.mjs` | Lo del operador |
| `src/sdk/model-context.mjs` | `toModelContext` y el envoltorio de lo que lee un modelo |
| `src/sdk/log-checks.mjs` y `src/sdk/scopes.mjs` | Comprobaciones del registro y de los permisos de una delegación |

`index.mjs` baja unas 330 líneas y **vuelve a exportar todo lo que exportaba**: quien importa de `…/src/sdk/index.mjs` no nota nada. Las clases de error son las mismas, así que `instanceof` sigue funcionando.

Al preguntar se dijo «unas 600 líneas cada uno»: contadas sobre los rangos del issue, son unas 375 y unas 330.

### 3. Lo que arrastra cada paso

- **La cabecera de licencia** en cada fichero nuevo: AGPL en `src/hub/`, Apache en `src/sdk/`.
- **Los guiones de mutaciones** (`experiments/mutations/`) buscan su texto en un fichero concreto: los que apuntan a código que se mudó se actualizan, y se pasan todos.
- **Las declaraciones** de ALB-324 se regeneran.
- **`CLAUDE.md`, «Estructura»:** los ficheros nuevos.

## Tests

- `test/surface.test.mjs`, del paso 0.
- **Todos los demás, sin tocar.** Es la prueba de que nada cambió.

## Comprobación

- `npm test`, `npm run demo` y `bash checks/all.sh` después de cada paso.
- Las mutaciones: todas cazadas.
- Las dos listas del paso 0 no cambian en los pasos 1 y 2.

## Lo que queda, para decidir después

Tal como lo describe el issue, cada cosa en su propio issue cuando toque:

- **Hub:** un contexto explícito en vez del cierre; el enrutado, la autenticación, los niveles, las fichas y los streams como módulos; las rutas por dominio; el ciclo de vida. `server.mjs` quedaría como fachada.
- **SDK:** un núcleo interno con el estado compartido, y los componentes (directorio, registro, topics, envío, MLS, recepción, escucha).
- **Tests por módulo,** que es para lo que sirve todo lo anterior.

Para retomarlo hará falta saber qué tests unitarios se echan de menos de verdad: es lo que justifica el rediseño, y con esta primera parte hecha se verá mejor.

## Documentación

- `docs/HANDOFF.md`: sección nueva: qué se movió, qué se dejó y por qué.
- `README.md` y `CLAUDE.md`: la estructura y el número de tests.
