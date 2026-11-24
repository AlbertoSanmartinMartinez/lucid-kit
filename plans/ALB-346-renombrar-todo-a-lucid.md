# ALB-346 · Colisión de nombre: todo pasa de «Agent Hub» a LUCID

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-346
- **Rama:** `info/alb-346-colision-de-nombre-agent-hub-choca-con-agenthub`
- **Prioridad:** High. Bloquea ALB-328 (npm), ALB-329 (registro de MCP) y ALB-348 (README en inglés).
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.

## El problema

El proyecto se llama LUCID hacia fuera, pero el desarrollador ve «Agent Hub» en todas partes: el título del README, el comando `agenthub`, las variables `AGENTHUB_*`, la etiqueta que lee el modelo. Es el mismo nombre que AgentHub, el producto de Moflet, bajo la misma cuenta de GitHub. Publicar fija los nombres, así que se decide antes.

## Decisiones del dueño

| Pregunta | Decisión |
|---|---|
| Qué nombre | **LUCID** en los textos y **`lucid`** en los identificadores. Un solo nombre. «AI Hub» no se usa |
| Hasta dónde llega | **Todo, también el protocolo:** los contextos de firma y las cabeceras de las peticiones |
| El comando y las variables | **`lucid` y `LUCID_*`, corte limpio.** Sin alias ni periodo de transición: en npm no hay nada publicado |
| La búsqueda de marca | **No se espera.** El código se renombra ya; la búsqueda de Legal va en paralelo y solo bloquea publicar |

## Lo que esta decisión rompe

Renombrar el protocolo es una ruptura completa, y se acepta porque nadie de fuera depende todavía de él:

- **Toda firma hecha hasta hoy deja de valer:** tarjetas, delegaciones, declaraciones, eventos, el registro de transparencia.
- **Los datos de un hub de antes no sirven.** El hub alojado empieza con un directorio vacío y una clave nueva: con la misma, quien siguiera su registro lo vería como un hub que reescribió su historia.
- **Una versión de antes y una de después no se entienden,** ni hub con hub ni cliente con hub.
- **Las claves de los agentes sí sirven** (un `did:key` no lleva el nombre), pero se registran de nuevo y olvidan lo que seguían del registro.

Si Legal dijera que LUCID no se puede usar, este renombrado se repite con otro nombre, y con él la ruptura. Es el riesgo de no esperar.

## Qué cambia

Hoy hay unas 450 apariciones del nombre viejo en unos 80 ficheros.

| Hoy | Pasa a |
|---|---|
| «Agent Hub», en textos | LUCID |
| El comando `agenthub` y `bin/agenthub.mjs` | `lucid` y `bin/lucid.mjs` |
| `AGENTHUB_URL`, `_IDENTITY`, `_CONTROLLER`, `_GUARDIAN`, `_WITNESSES`, `_WITNESS_QUORUM` | `LUCID_…` |
| Las variables de los guiones de `checks/` (`AGENTHUB_OLD_TREE`, `_CHECK_DIR`…) | `LUCID_…` |
| El directorio por defecto, `~/.agenthub/` (ALB-305) | `~/.lucid/` |
| Los 24 contextos de firma, `agenthub/<cosa>/v<n>` | `lucid/<cosa>/v<n>`, con el mismo número |
| Los prefijos de los grupos de MLS (`agenthub/dm/v1`, `agenthub/topic/v1`) | `lucid/…` |
| Las 5 cabeceras, `x-agenthub-*` | `x-lucid-*` |
| `agenthub-verifier`, `agenthub-witness`, `agent-hub` (nombres que dan los servicios de sí mismos) | `lucid-verifier`, `lucid-witness`, `lucid` |
| Las etiquetas que lee el modelo: `<agenthub_message>`, `<agenthub_directory>`, `<agenthub_hub>` | `<lucid_message>`… |
| Las 13 métricas, `agenthub_*` | `lucid_*` |
| El servidor en `.mcp.json` (`agenthub`) | `lucid` |
| La imagen (`agenthub/hub`), la unidad de systemd (`agenthub.service`), las copias (`agenthub-<fecha>`) | `lucid…` |
| `LICENSE`: «The Agent Hub authors» | «The LUCID authors» |

**Lo que no cambia:** el nombre del repositorio (`lucid-kit`), los nombres de las herramientas de MCP (`hub_status`, `hub_send`…), las rutas HTTP (`/v1/…`), los formatos de C2SP de los testigos y los `did:key`.

## Pasos

Un commit por paso, con `npm test` en verde en cada uno. Cada paso es buscar y sustituir, revisado fichero a fichero.

**1. El protocolo.** Los contextos de firma, los prefijos de MLS, las cabeceras y los nombres de los servicios, en `src/` y en sus tests. `site/assets/verify.mjs` repite la comprobación del núcleo y cambia con él; lo que la landing enseña como bytes del protocolo se vuelve a generar con `site/tools/fixtures.mjs`.

**2. Un hub no arranca sobre datos de antes.** Al arrancar comprueba su propio registro con las reglas de hoy, como mínimo su primera entrada firmada. Si no vale, no arranca y lo dice: `the data in <dir> was written before the protocol was renamed and cannot be used: start from an empty directory`. Sin esto arrancaría y fallaría más tarde, al leer su registro.

**3. El CLI, las variables y el directorio.** `bin/lucid.mjs`, `LUCID_*`, `~/.lucid/`, la ayuda, `.mcp.json` y `server.json`.

**4. Lo que lee el modelo y lo que lee el operador.** Las etiquetas (`toModelContext`, el servidor MCP y sus instrucciones) y las métricas.

**5. El despliegue y las comprobaciones.** El `Dockerfile`, `deploy/self-hosted/`, los guiones de `checks/` y la CI.

**6. Los textos.** `README.md`, `LICENSE`, las descripciones de `package.json` y `server.json`, `CLAUDE.md`, `AGENTS.md`, `docs/` y la landing en sus dos lenguas.

**7. Un test que lo vigila** (abajo).

## Tests

- **Los que hay** cambian con el código: 135 apariciones en 23 ficheros.
- **`test/naming.test.mjs`, nuevo:** el nombre viejo, en cualquiera de sus formas, no aparece en ningún fichero del repositorio salvo en una lista corta y escrita en el test: las secciones de `docs/HANDOFF.md` y `docs/DESIGN.md` que cuentan lo que pasó, y lo que las comprobaciones de versiones esperan de la versión anterior.
- **Un hub sobre datos de antes del cambio no arranca** y dice por qué: con un directorio de datos escrito por la `v1.0.0`, guardado en `test/fixtures/`.
- **Una petición firmada con las cabeceras viejas** se rechaza como una sin firmar.
- **Las mutaciones** de `experiments/mutations/`: sus guiones llevan trozos de código y cambian con él. Se pasan todos: todas cazadas.

## Lo que cambia en otros planes

| Plan | Qué cambia |
|---|---|
| ALB-305 | El directorio por defecto es `~/.lucid/`, y la variable `LUCID_IDENTITY` |
| ALB-314 | El comando es `lucid`. Si se eligen dos comandos, el del hub se decide con este nombre a la vista |
| ALB-327 | Su criterio «los datos de la 1.0.0 siguen cargando» vale para el formato del almacén, pero un hub ya no arranca sobre esos datos (paso 2) |
| ALB-328 | Las descripciones de los paquetes dicen LUCID. Publicar sigue esperando a Legal |
| ALB-329 | Las variables de la ficha son `LUCID_URL` y `LUCID_IDENTITY` |
| Las comprobaciones de versiones (`upgrade.sh`, `mixed-hubs.sh`, `mixed-clients.sh`) | Entre la 1.0.0 y la siguiente no hay actualización posible: pasan a comprobar que las dos versiones se rechazan con un error claro. `upgrade.sh` vuelve a tener sentido a partir de la versión siguiente |

## Documentación

- `README.md`: el título, las órdenes, las variables y una nota de migración corta: qué hace quien tenía un hub o un agente de la 1.0.0.
- `docs/HANDOFF.md`: sección nueva con las decisiones y la ruptura. Las secciones anteriores no se reescriben: una línea al principio dice que hasta la 38 el proyecto se llamaba Agent Hub y su comando `agenthub`. La sección 35 decía que el código se renombraría: queda hecho.
- `docs/SELF-HOSTING.md`, `checks/README.md`, `site/README.md` y `CLAUDE.md` (título, órdenes, y la regla «Firmas», que nombra `agenthub/request/v2`).

## Comprobación

- `npm test` y `npm run demo`.
- `bash checks/all.sh` y `checks/self-hosted.sh`.
- `git grep -i 'agent.\?hub'` devuelve solo lo que está en la lista del test.

## Lo que hace el dueño

- **La búsqueda de marca**, con Legal: LUCID, `uselucid.org`, el choque con «Lucid Agents» y con las marcas generalistas. Bloquea publicar, no este cambio.
- **El servicio alojado**, en su repositorio: sus imports, órdenes y variables, y empezar con datos vacíos y una clave nueva.

## Fuera de este issue

- **La relación comercial con Moflet:** ALB-347.
- **Los nombres de los paquetes:** decididos en ALB-314 (`@uselucid/kit` y `@uselucid/hub`).
- **Comprobar la versión del protocolo entre hubs:** ALB-308.
