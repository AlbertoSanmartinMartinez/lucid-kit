# ALB-321 · SDK: los fallos al renovar claves de MLS y al publicar KeyPackages se tragan sin avisar

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-321
- **Rama:** `info/alb-321-m6-sdk-los-fallos-al-renovar-claves-mls-y-al`
- **Prioridad:** Medium
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.

## El problema

En `src/sdk/index.mjs` hay siete sitios donde un fallo se descarta a propósito, para no parar el mensaje que se estaba enviando o leyendo:

| Qué se intentaba | Dónde |
|---|---|
| Renovar las claves antes de enviar | Dos sitios: una conversación y un topic privado |
| Renovar las claves después de leer | Uno |
| Pedir volver a entrar en un grupo del que el cliente quedó fuera | Dos |
| Publicar KeyPackages | Dos: al escuchar y al leer el buzón |

Cada uno tiene su porqué, pero la aplicación nunca se entera. Si la renovación lleva días fallando, el secreto hacia adelante está degradado y nadie lo sabe. Si fallan los KeyPackages, nadie puede abrir una conversación sobre MLS con este agente.

## Lo que se propone

Lo que dice el issue: un aviso que la aplicación puede escuchar. El mensaje sigue saliendo o leyéndose igual.

## Cambios

### 1. `onWarning`, opción nueva de `AgentClient` (`src/sdk/index.mjs`)

```js
new AgentClient({ onWarning: (err, { what, group }) => { … } })
```

- `what`: `'renew'`, `'ask_back_in'` o `'key_packages'`.
- `group`: el grupo de MLS, cuando lo hay.
- Por defecto no hace nada, como hoy.
- Se llama en los siete sitios, en vez de descartar el error.
- **Un error dentro de `onWarning` no rompe nada:** se descarta. Avisar no puede ser lo que pare un mensaje.

El error es el que hubo, con su marca de si las palabras son del hub (`fromHub`), como cualquier `HubError`.

### 2. CLI (`bin/agenthub.mjs`)

Lo escribe por la salida de errores: `warning: could not renew the keys of a conversation (<código>)`. Solo el código del error: el texto de un hub no se repite.

### 3. Servidor MCP

Lo escribe en su registro, que va por la salida de errores y no llega al modelo. El modelo no puede hacer nada con ello; quien opera el agente, sí.

## Tests

En `test/mls.test.mjs` y `test/topics-mls.test.mjs`, con un hub de prueba que falla justo en esa petición:

1. **La renovación antes de enviar falla:** el mensaje sale igual y `onWarning` recibe `what: 'renew'` con su grupo.
2. **La renovación después de leer falla:** el mensaje se entrega igual, y se avisa.
3. **Pedir volver a entrar falla:** se avisa con `what: 'ask_back_in'`.
4. **Publicar KeyPackages falla** al escuchar y al leer el buzón: se avisa con `what: 'key_packages'`, y la lectura sigue.
5. **Un `onWarning` que lanza un error** no impide enviar ni leer.
6. **Sin `onWarning`,** todo sigue como hoy.

En `test/mcp.test.mjs`: el aviso sale en el registro del servidor y no en ninguna respuesta al modelo.

## Documentación

- `README.md`: `onWarning` entre las opciones del SDK, y qué significa cada aviso para quien opera un agente. Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`: sus recorridos renuevan claves de verdad; no debería salir ningún aviso, y si sale es un hallazgo.

## Fuera de este issue

- **Contar los fallos o dejar de enviar** cuando la renovación lleva mucho sin funcionar: hoy solo se avisa.
- **Los fallos de `listen` y de `poll`,** que ya tienen su camino (`onError`, `errors`).
