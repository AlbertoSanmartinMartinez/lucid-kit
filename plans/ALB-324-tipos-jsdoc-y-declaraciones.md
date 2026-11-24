# ALB-324 · Tipos: JSDoc incompleto o desfasado, y sin declaraciones para el SDK

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-324
- **Rama:** `info/alb-324-m9-tipos-jsdoc-incompleto-o-desfasado-82`
- **Prioridad:** Medium
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.
- **Va después de ALB-314:** las declaraciones van dentro de `@uselucid/kit`.

## El problema

1. **`tsc --checkJs` da 82 errores:** 31 en `src/sdk/index.mjs`, 15 en `src/hub/server.mjs`, 6 en el CLI y el resto repartidos. Casi todos son opciones sin su `@param`, o con uno que ya no coincide con la función. La revisión no vio ningún fallo real entre ellos.
2. **Quien usa el SDK desde TypeScript no recibe tipos,** ni autocompletado. Y el JSDoc que hay a veces engaña.

## Decisión del dueño

**Las declaraciones se generan con una orden y se guardan en el repositorio.** La CI comprueba que están al día. El paquete publicado sigue siendo exactamente lo que hay en el repositorio, sin paso de construcción al publicar. A cambio, hay ficheros generados en los diffs.

Esto trae **TypeScript como dependencia de desarrollo**, con versión exacta. No entra en lo que se publica. Es la primera dependencia de desarrollo del proyecto, y se dice en el README, como manda la convención.

## Cambios

### 1. Comprobar los tipos

- **`jsconfig.json`** en la raíz: `checkJs`, sin `strict`, sin emitir nada. Cubre `src/` y `bin/`.
- **`npm run types`:** `tsc --noEmit`.
- **Los 82 errores, corregidos en el JSDoc.** Es documentación: ninguna función cambia de firma ni de comportamiento. Si alguno resulta ser un fallo real, se arregla aparte, con su test.

### 2. Las declaraciones

- **Qué:** las del lado cliente, que es lo que alguien importa: `src/core`, `src/mls`, `src/sdk` y `src/mcp` (36 ficheros hoy). El hub no se importa desde TypeScript.
- **Dónde:** cada `.d.mts` junto a su `.mjs`. TypeScript busca ahí por su cuenta, así que quedan tipados tanto `import '@uselucid/kit'` como los imports por ruta que usa el servicio alojado, sin tocar el mapa de `exports`.
- **`npm run types:emit`** las regenera. Se guardan en el repositorio y viajan en el paquete, que ya lleva `src/`.

### 3. En la CI

Un paso, en una versión de Node:

1. `npm run types`: no hay errores.
2. `npm run types:emit` y `git diff --exit-code`: las declaraciones guardadas son las que salen del código.
3. **Un consumidor de verdad:** un fichero TypeScript pequeño en `checks/types/` que importa `@uselucid/kit`, usa `AgentClient` bien y, en una línea marcada, mal. Tiene que compilar lo primero y fallar lo segundo. Es lo que prueba que los tipos sirven a quien los usa, y no solo que existen.

## Tests

- `test/package.test.mjs`: lo que llevaría `@uselucid/kit` incluye un `.d.mts` por cada `.mjs` de esas cuatro carpetas, y TypeScript no está entre las dependencias que se instalan con el paquete.
- `test/licenses.test.mjs`: sigue pasando. Mira los `.mjs`; los `.d.mts` son generados.
- Lo demás lo comprueba el paso de la CI de arriba, fuera de `npm test`: pasar `tsc` tarda varios segundos.

## Documentación

- `README.md`: que el paquete trae tipos, las dos órdenes, y TypeScript entre las dependencias, como de desarrollo.
- `CLAUDE.md`: en «Convenciones», las dependencias de desarrollo; en «Forma de trabajar», que quien cambia una firma pública regenera las declaraciones.
- `docs/HANDOFF.md`: sección nueva con la decisión.

## Comprobación

- `npm test` en verde antes y después: corregir JSDoc no cambia nada que corra.
- El paso nuevo de la CI, en verde.
- `bash checks/all.sh`.

## Fuera de este issue

- **`strict`, fichero a fichero:** el cuarto punto del issue. Se abre cuando lo básico esté en verde.
- **Un linter:** descartado en ALB-313.
- **Declaraciones para el hub.**
