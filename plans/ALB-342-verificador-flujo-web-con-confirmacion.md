# ALB-342 · Verificador de GitHub: el flujo de dispositivo se puede usar para engañar a alguien

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-342
- **Rama:** `info/alb-342-seguridadlow-verificador-de-github-el-device`
- **Prioridad:** Low (seguridad)
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.
- **Va después de ALB-331,** que deja el verificador detrás de un proxy con HTTPS: una página web con sesión lo necesita.

## El problema

El verificador usa el flujo de dispositivo de GitHub: da un código, alguien lo mete en GitHub, y la clave del controlador queda atestada como esa cuenta.

Nada ata el código a quien lo pidió. Alguien puede iniciar una verificación con **su** clave y convencer a otra persona de que meta el código: su clave queda atestada como la cuenta de la víctima. GitHub enseña qué aplicación pide permiso, pero no qué clave se está vinculando.

Es un riesgo conocido de ese flujo, y el código lo declara y lo acepta. No hay un fallo: hace falta engañar a una persona.

## Decisión del dueño

**Añadir el flujo web con confirmación.** El verificador gana una página propia que enseña qué clave se va a atestar y pide confirmarlo. El flujo de dispositivo se queda para quien use el CLI sin navegador.

No entra que el titular de una cuenta pueda ver y retirar sus atestaciones: pediría una pieza nueva del protocolo, y se descartó.

## Cómo funciona el flujo web

1. **El CLI pide una verificación,** demostrando que tiene la clave del controlador, como hoy. El verificador contesta con una dirección suya y un código corto de comparación.
2. **El CLI enseña la dirección y el código,** y espera.
3. **La persona abre la página del verificador.** Ve la clave que se va a atestar, el código de comparación y una frase clara: *sigue solo si esto lo empezaste tú en tu terminal y el código es el mismo*.
4. **Pulsa continuar** y va a GitHub a dar permiso, por el flujo web normal.
5. **GitHub la devuelve al verificador,** que ya sabe qué cuenta es. Una última página: *vas a atestar esta clave como esta cuenta*. Confirmar o cancelar.
6. **Al confirmar,** el verificador firma la atestación y el CLI, que seguía esperando, la recibe.

Lo que añade frente al flujo de dispositivo: quien da el permiso ve, en una página del verificador y no de GitHub, **qué clave** queda vinculada a **qué cuenta**, y lo confirma con las dos cosas delante.

**Lo que no arregla, y se dice:** alguien a quien convencen de pulsar confirmar sin mirar. Ningún flujo arregla eso. Las atestaciones caducan a los 30 días.

## Cambios

### 1. El verificador (`src/verifier/`)

- **Las rutas del flujo web:** la página de inicio de una verificación, la vuelta de GitHub y la confirmación.
- **Páginas mínimas:** HTML sin JavaScript ni recursos de fuera, con una política de contenido estricta. Todo lo que enseñan va escapado: una clave tiene forma comprobada, pero el nombre de la cuenta lo escribe GitHub y es dato.
- **Lo que protege los pasos entre sí:** un valor de un solo uso que ata la vuelta de GitHub a su verificación; una sesión del navegador en una cookie que solo viaja por HTTPS y que el JavaScript no ve; y una marca contra peticiones falsificadas en cada formulario. Sin la sesión que empezó, la vuelta no vale.
- **El secreto de la app de GitHub.** El flujo web lo necesita; el de dispositivo, no. Se da en un fichero (`--github-client-secret-file`), nunca en la línea de órdenes, y no se escribe en ningún registro.
- **Sin secreto, el verificador ofrece solo el flujo de dispositivo,** como hoy. `/v1/info` dice qué flujos ofrece.
- **La verificación sigue en memoria** y dura 15 minutos, como hoy.

### 2. El CLI (`controller verify`)

- **Usa el flujo web** si el verificador lo ofrece: enseña la dirección y el código de comparación.
- **`--device`** elige el de dispositivo. Su texto dice más claro que hoy que el código solo lo mete quien lanzó la orden.

### 3. El SDK

Las funciones que hablan con el verificador (`askVerifier`, `waitForVerification`) aprenden el flujo nuevo. La espera es la misma.

## Tests

En `test/verifier.test.mjs`, con el doble de GitHub que ya existe, ampliado al flujo web:

1. **El recorrido entero:** pedir, abrir, ir a GitHub, volver, confirmar, y el CLI recibe la atestación.
2. **Sin confirmar no hay atestación.** Y al cancelar, tampoco.
3. **La página enseña la clave y el código** que el CLI enseñó.
4. **Casos de ataque:**
   - la vuelta de GitHub con un valor que no es el de esa verificación;
   - la misma vuelta usada dos veces;
   - la vuelta en un navegador que no empezó la verificación;
   - la confirmación sin su marca;
   - un nombre de cuenta con HTML dentro, que sale escapado.
5. **Sin secreto,** el flujo web no se ofrece y el de dispositivo sigue funcionando.
6. **El secreto no sale** en ninguna respuesta ni en ninguna línea del registro.

## Documentación

- `README.md` y `docs/SELF-HOSTING.md`: los dos flujos, cuál usar, cómo se configura la app de GitHub para el flujo web (su dirección de vuelta) y dónde va el secreto. Número de tests, en el README y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva: lo decidido, lo que el flujo web añade y lo que no arregla.
- El comentario del código que hoy declara el riesgo se pone al día.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`: `tour.sh` hace una verificación con un GitHub simulado; gana el flujo web.

## Lo que no queda verificado

El flujo web contra GitHub de verdad. Se añade al recorrido de ALB-330. Cómo pide GitHub hoy cada paso del flujo web se toma de su documentación al implementarlo.

## Fuera de este issue

- **Ver y retirar las atestaciones de una cuenta.**
- **Otros proveedores** además de GitHub.
- **Varias réplicas del verificador:** la sesión vive en la memoria de un proceso.
