# ALB-313 · CI: mejoras del workflow

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-313
- **Rama:** `info/alb-313-ci-mejoras-del-workflow-pin-por-sha-node-26`
- **Prioridad:** Medium
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.

## El problema

La CI ya hace lo importante: los tests en tres versiones de Node, `checks/all.sh` con los clientes oficiales de MCP y A2A, y la imagen del hub. El issue trae una lista de diez mejoras, y pide que cada una quede aplicada o descartada con su motivo.

## Decisiones del dueño

| Pregunta | Decisión |
|---|---|
| Versiones de Node | **22, 24 y 26.** Node 20 se deja: está sin soporte desde abril de 2026. `engines` pasa a `>=22` |
| Linter | **Sin linter por ahora.** El proyecto mantiene sus dependencias al mínimo, y los tipos llegan con ALB-324 |
| Sistemas | **macOS y Windows**, además de Linux, para `npm test`. Es comprometerse a que el proyecto funcione en Windows |

## La lista, punto por punto

| # | Punto del issue | Qué se hace |
|---|---|---|
| 1 | Acciones fijadas por SHA, y Dependabot | **Se aplica.** Cada `uses:` con el SHA de su commit y la versión en un comentario. Dependabot semanal y agrupado para `github-actions` y para `npm` (la raíz, `checks/mcp-client` y `checks/a2a-client`) |
| 2 | Node 26 en la matriz | **Se aplica**, con la decisión de arriba: la matriz es 22, 24 y 26, y `engines` dice `>=22` |
| 3 | Umbral de cobertura | **Se aplica.** Un paso con el corredor de tests de Node: 95 % de líneas y 90 % de ramas sobre `src/` y `bin/`, en una versión de Node. El informe se sube como artefacto |
| 4 | Orden aleatorio de los tests | **Se aplica si se puede.** El issue dice que la opción existe desde Node 24; el Node 22 de aquí no la tiene. Se comprueba al implementarlo, en una sola versión y anotando la semilla. Si la opción no existe, se descarta con ese motivo |
| 5 | Lint y tipos | **Lint, descartado** por decisión del dueño. **Tipos:** ALB-324 |
| 6 | macOS y Windows | **Se aplica**, para `npm test`, con una versión de Node en cada uno. Abajo, lo que se espera que salga |
| 7 | El job `checks` en más versiones, y sus logs | **Se aplica.** Corre en 22, 24 y 26. Si falla, el directorio de cada comprobación se sube como artefacto |
| 8 | Un job programado con las comprobaciones de versiones contra la 0.6 | **Descartado.** El código de la 0.6 no está en este repositorio. Esas tres comprobaciones entran en `all.sh` al cerrar la versión siguiente (ALB-308) |
| 9 | `cancel-in-progress` solo en pull requests | **Se aplica.** Un push a `main` ya no cancela la ejecución anterior: ningún commit de `main` se queda sin verificar |
| 10 | Auditoría de dependencias | **Se aplica**, en un workflow aparte: `npm audit --omit=dev` cada semana y cuando cambia un fichero de bloqueo. Aparte para que un aviso nuevo no ponga en rojo un push que no tiene que ver |

## Lo que traerá Windows

Los tests no han corrido nunca ahí. Se espera que fallen, como poco:

- **Permisos de ficheros.** Las claves se guardan con modo `0600`, y los tests lo comprueban. En Windows ese modo no existe.
- **Señales.** Parar un proceso con `SIGINT` o `SIGTERM` no le deja cerrar ordenadamente.
- **Rutas y fines de línea.**

Cada fallo se resuelve de una de dos maneras, y se anota en el issue:

1. **El producto se arregla** para que funcione en Windows.
2. **Si la garantía no existe en Windows** (el modo `0600`), el test dice por qué no se aplica ahí, y el README dice qué no se garantiza en Windows.

Ningún test se salta solo para poner la CI en verde. `checks/` son guiones de `bash` y siguen corriendo solo en Linux, como el hub que se despliega.

## Cambios

- `.github/workflows/ci.yml`: los puntos 1, 2, 3, 4, 6, 7 y 9.
- `.github/workflows/audit.yml`, nuevo: el punto 10.
- `.github/dependabot.yml`, nuevo: el punto 1.
- `package.json`: `engines` a `>=22`, y un script `coverage` con los umbrales, para pasarlo igual en local.
- Lo que haga falta en el producto y en los tests para Windows.

Con ALB-314 (dos paquetes) cambian los directorios de `npm` que vigila Dependabot. Con ALB-328, el workflow de release sigue las mismas reglas: acciones por SHA.

## Tests

En `test/package.test.mjs`:

1. **Cada `uses:` de cada workflow** va fijado por un SHA de 40 caracteres.
2. **`engines` y la matriz dicen lo mismo:** la versión más baja de la matriz es la que promete el paquete.

## Documentación

- `README.md` y `CLAUDE.md`: «Node 22 o superior», los sistemas en los que se prueba, y lo que no se garantiza en Windows.
- `docs/HANDOFF.md`: sección nueva con la tabla de arriba.
- **En el issue de Linear:** la tabla, con cada punto aplicado o descartado y su motivo. Es su criterio de aceptación.

## Comprobación

- La CI en verde en los tres sistemas y las tres versiones.
- `npm run coverage` pasa en local con los umbrales.

## Fuera de este issue

- **Dejar de usar lo que solo hacía falta por Node 20** en el código: se hace cuando se toque cada sitio.
- **Tipos y `tsc --checkJs`:** ALB-324.
- **El workflow de release:** ALB-328.
