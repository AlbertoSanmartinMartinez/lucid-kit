# ALB-344 · Confianza en el primer uso: un hub sin registro se acepta, y un cliente sin estado admite tarjetas antiguas

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-344
- **Rama:** `info/alb-344-seguridadlow-confianza-en-el-primer-uso-el`
- **Prioridad:** Low (seguridad)
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.
- **Va después de ALB-346,** que deja fuera a los hubs de antes del registro, y de ALB-321, que trae la forma de avisar.

## El problema

Dos casos en los que un cliente se fía de lo primero que ve:

1. **Un hub que dice no tener registro se da por bueno.** Quien sigue el registro de un hub y recibe un «no hay» la primera vez, lo acepta: se pensó para los hubs de antes de que hubiera registro. Un hub malicioso puede esconder el suyo a un cliente nuevo. Además, de quién es el hub (su DID) se fija con lo primero que el hub dice.
2. **Un cliente sin estado no recuerda nada.** No sabe cuál fue la última tarjeta que vio de un agente, así que acepta una anterior, bien firmada: por ejemplo, con una clave de cifrado que ya se cambió.

Los dos piden controlar el hub, y solo afectan al primer contacto o a clientes sin estado.

## Lo que hay hoy, mirado en el código

| Lo que pide el issue | Lo que hay |
|---|---|
| Poder fijar de antemano el DID del hub | **El SDK ya lo admite** (`hubDid`). Lo que falta es que el CLI y el servidor MCP lo usen: hoy no se lo pasan a su cliente |
| No aceptar un hub sin registro | Falta |
| Avisar cuando un cliente corre sin estado | Falta |

## Lo que se propone

### 1. Un hub sin registro no es un hub de este protocolo

Se quita la tolerancia, sin opción: si el hub no enseña su registro, el cliente que lo sigue lo rechaza. Con ALB-346 ya no queda ningún hub compatible que no lo tenga, así que no hay a quién proteger con esa excepción, y sí a quién engañar.

### 2. El DID del hub, fijado por quien configura

- **CLI y servidor MCP:** una opción y una variable para decir el DID del hub (`--hub-did`, que hoy solo usa una orden, pasa a ser general). Con ella, el cliente no acepta un registro firmado por otra clave.
- **Sin ella, primer uso:** el cliente se queda con el DID que ve la primera vez y lo guarda en su estado, como hoy. Lo nuevo es que **lo dice**, una vez: a qué hub se está fiando y cómo fijarlo.
- **Si ese DID cambia después,** el cliente ya lo rechaza hoy. Un test lo fija.

### 3. Un cliente sin estado lo dice

Al crear un `AgentClient` sin estado, un aviso por el camino de ALB-321 (`onWarning`): este cliente no puede distinguir una tarjeta vieja de la actual, ni un registro recortado.

**Por qué solo avisar,** y no comprobar la tarjeta contra el registro como sugiere el issue: sin memoria, el cliente no puede saber si el estado del registro que le enseñan es el último. Un hub malicioso le daría una tarjeta vieja con un estado viejo del registro, los dos auténticos y coherentes entre sí. La comprobación costaría una petición más y no pararía ese ataque. Lo que sí lo para ya existe:

| Con qué | Qué protege |
|---|---|
| Estado en disco | El cliente recuerda hasta dónde vio el registro: no se le puede enseñar uno más corto |
| Testigos | Un estado cofirmado hace poco por terceros: vale también para un cliente sin estado |

Se documenta así, con esa tabla.

## Tests

En `test/log.test.mjs` y `test/trust.test.mjs`, con un hub de prueba que hace de malicioso:

1. **Un hub que esconde su registro a un cliente nuevo:** el cliente lo rechaza.
2. **Con el DID fijado,** un registro firmado por otra clave se rechaza desde la primera vez.
3. **Sin fijarlo,** el primer uso funciona, sale el aviso una vez, y un cambio de clave después se rechaza.
4. **El CLI y el servidor MCP** pasan el DID fijado a su cliente.
5. **Un cliente sin estado** avisa al crearse, una vez; uno con estado, no.
6. **Con testigos,** un cliente sin estado rechaza un estado del registro que no está cofirmado hace poco. Ya es así; el test lo fija.

Las defensas del registro llevan su mutación en `experiments/mutations/logstate.py`.

## Documentación

- `README.md`: qué se fía en el primer uso y cómo dejar de fiarse (fijar el DID, guardar estado, pedir testigos). Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva, con el porqué de no comprobar contra el registro sin memoria.

## Comprobación

- `npm test` en verde antes y después.
- Las mutaciones: todas cazadas.
- `bash checks/all.sh`.

## Fuera de este issue

- **Que el SDK sin estado siga el registro en memoria** durante la vida del proceso.
- **Una red de testigos pública,** que es lo que daría esta protección a todos por defecto.
