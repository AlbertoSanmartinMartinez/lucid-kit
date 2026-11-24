# ALB-340 · Los mensajes directos sin cifrar se aceptan por defecto

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-340
- **Rama:** `info/alb-340-seguridadlow-los-mensajes-directos-sin-cifrar`
- **Prioridad:** Low (seguridad)
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.
- **Conviene con ALB-346:** el protocolo ya se rompe ahí, y cambiar un valor por defecto en la misma versión no le cuesta nada a nadie.

## El problema

Un hub acepta por defecto mensajes directos sin cifrar: solo los rechaza si su operador arranca con `--require-e2e`. Quien integra sin conocer esa opción puede mandar contenido que el hub lee, y el proyecto parte de que el hub no es de fiar.

No es un fallo de la criptografía. Es un valor por defecto que apunta al lado contrario.

## Decisión del dueño

**Cifrado obligatorio por defecto.** El hub rechaza los mensajes directos en claro salvo que su operador lo permita, y el SDK no manda en claro salvo que quien envía lo pida en ese envío.

## Lo que hay hoy, mirado en el código

El issue dice dos cosas, y solo una está como la describe:

| Lo que dice el issue | Lo que hay |
|---|---|
| El hub acepta mensajes en claro por defecto | **Cierto.** `requireDirectEncryption` vale `false` |
| El SDK manda en claro, sin avisar, si el destinatario no tiene clave de cifrado | **No lo hace hoy.** `send()` cifra por defecto; si no puede, falla. Solo manda en claro con `encrypt: false` escrito en ese envío |

Así que el cambio es del hub. Del SDK, lo que falta es un test que fije lo que ya hace, para que no se pierda.

## Cambios

### 1. El hub (`src/hub/server.mjs` y el CLI)

- **`requireDirectEncryption` pasa a `true`** por defecto.
- **La opción del CLI se da la vuelta:** desaparece `--require-e2e` y aparece `--allow-plaintext-dm`, para el operador que quiera permitirlos (una red de pruebas, por ejemplo). Corte limpio, sin alias, como en el renombrado.
- **Vale igual para lo que cruza entre hubs,** que ya mira la misma opción.
- **Al arrancar con `--allow-plaintext-dm`,** el hub lo dice en una línea: es lo que su operador debe saber que tiene abierto.
- `/v1/info` ya anuncia si el hub lo exige; no cambia.

### 2. El SDK

Sin cambios de comportamiento. Un mensaje con `encrypt: false` a un hub que exige cifrado recibe `403 encryption_required`, que ya existe.

### 3. El servidor MCP

`hub_send` cifra siempre y no ofrece mandar en claro; sigue igual.

## Tests

En `test/e2e.test.mjs` y `test/federation.test.mjs`:

1. **Un hub sin opciones rechaza un mensaje directo en claro:** `403 encryption_required`.
2. **Con la opción, lo acepta,** y lo dice al arrancar.
3. **Entre hubs:** un mensaje en claro hacia un hub que exige cifrado se rechaza.
4. **El SDK no baja a claro por su cuenta:** con un destinatario sin clave de cifrado y sin MLS, `send()` falla, y al hub no le llega nada. Es lo que ya hace hoy.
5. **Los topics públicos no cambian:** sus eventos van firmados y en claro, que es lo que son.

**Los tests que ya hay:** 35 envíos en seis ficheros usan `encrypt: false` por comodidad (para probar instancias o cuotas, no el cifrado). Sus hubs de prueba pasan a permitirlo expresamente, y así queda dicho en cada test qué se está permitiendo.

## Documentación

- `README.md` y `docs/SELF-HOSTING.md`: el cifrado de los mensajes directos es obligatorio por defecto, y la opción que lo abre. Número de tests, en el README y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva con la decisión.
- Las notas de la versión: cambia un valor por defecto y una opción del CLI.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`: `tour.sh` arranca un hub con `--require-e2e`, que deja de existir; se ajusta.
- `npm run demo`.

## Fuera de este issue

- **Los eventos de topics públicos,** que son en claro por lo que son. Para contenido reservado están los topics privados.
- **Rechazar HPKE y exigir MLS.** HPKE sigue siendo la salida para un cliente sin estado de MLS.
