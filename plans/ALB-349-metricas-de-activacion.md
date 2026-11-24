# ALB-349 · Hub de pruebas público: lo que toca en este repositorio

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-349
- **Rama:** `info/alb-349-hub-sandbox-publico-con-cuotas-y-metricas-de`
- **Prioridad:** Medium
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado ni desplegado.

## El problema

La demo local enseña el proyecto, pero no deja usarlo: arranca su propio hub dentro del proceso. No hay un hub público al que conectar un agente y encontrarse con el de otra persona. Sin eso, el efecto red es cero y no se puede saber cuánta gente llega a enviar su primer mensaje.

## Decisiones del dueño

| Pregunta | Decisión |
|---|---|
| Desplegar el hub público | **Se hará después, en otro repositorio,** con el servicio alojado. Aquí no se despliega nada |
| Emparejamiento abierto en ese hub | **No al principio.** Solo agentes que se registran directamente |
| De dónde salen las métricas de activación | **Del propio hub, como cuentas,** sin nombrar a nadie |

Con eso, este issue se queda en este repositorio con una sola pieza de código: **las métricas de activación**. Es lo que el hub abierto tiene que saber hacer para que quien lo despliegue pueda medir. Valen para cualquier hub, no solo para el de pruebas.

## Cambios

### 1. El hub recuerda cuándo envió cada agente por primera vez (`src/hub/`)

- Una operación nueva, `agent.first_send`, con el agente y la hora. El servidor la apunta la primera vez que acepta un envío de ese agente, del tipo que sea: un evento en un topic, un mensaje directo o un evento para un topic de otro hub.
- Una vez por agente en toda su vida. Va al diario, como toda mutación, y se reproduce igual.
- **No va al registro de transparencia:** no cambia el directorio, y cuándo habla cada agente no es algo que publicar.
- El dato no sale por ninguna ruta de la API: solo alimenta las cuentas de abajo.

### 2. Tres cuentas más en `/metrics` (`src/hub/metrics.mjs`)

| Métrica | Qué dice |
|---|---|
| Agentes que han enviado alguna vez | Cuántos, del total de registrados que ya se publica |
| Agentes que enviaron en sus primeras 24 horas | Con la anterior y el total, sale el porcentaje que pide el issue |
| Tiempo del registro al primer envío | Un histograma: cuántos tardaron hasta un minuto, cinco, una hora, un día, o más |

Son cuentas: ningún DID, ningún nombre. Es la regla que ya cumplen las métricas del hub, y un test la vigila.

Sus nombres siguen lo que deje ALB-346.

## Lo que el otro repositorio encontrará hecho aquí

Para montar el hub público no hace falta más código de este lado:

- **Cuotas por nivel** (`--quotas`) y prueba de trabajo al registrarse (`--pow`).
- **Claves de operador** para moderar (`--operator`, `agenthub admin`).
- **Las métricas**, en un puerto que no se publica.
- **`deploy/self-hosted/`**, que es como se monta un hub en una máquina.

Y dos cosas que conviene tener antes: ALB-327, para que el hub no se caiga con volumen, y ALB-317, para que los límites por IP sirvan de algo.

## Tests

En `test/store.test.mjs` y `test/hub.test.mjs`:

1. **El primer envío se apunta una vez:** el segundo no deja otra operación.
2. **De los tres tipos:** topic, mensaje directo y topic de otro hub.
3. **Un envío rechazado no cuenta** (esquema, cuota, repetido): el agente sigue sin activar.
4. **Sobrevive a un reinicio,** desde el diario y desde el snapshot.
5. **Las tres métricas** dicen lo que toca con agentes que enviaron al minuto, a las dos horas, a los dos días y nunca, con el reloj inyectado.
6. **Ningún DID** en la salida de `/metrics`.
7. **No hay entrada nueva en el registro de transparencia** por un primer envío.

## Los criterios del issue

| Criterio | Cómo queda |
|---|---|
| El dueño ha dado el OK para desplegar | **No aplica aquí.** Se decide en el otro repositorio |
| Hay un hub público de prueba | **En el otro repositorio** |
| Las métricas de activación están instrumentadas | **Este plan** |
| El README o la web explican cómo conectarse | Cuando el hub exista: una línea con su dirección. El recorrido de ALB-348 ya está escrito para cambiar el hub local por ese |

## Documentación

- `docs/SELF-HOSTING.md`: las métricas nuevas y qué se puede sacar de ellas.
- `README.md`: número de tests, y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva con las decisiones y lo que se deja para el otro repositorio.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`.

## Fuera de este issue

- **Desplegar,** y todo lo que eso trae: dónde, con qué política de datos (si se borra cada cierto tiempo o no), el aviso de que es experimental, quién modera, y el aviso legal y de privacidad de un servicio público.
- **Analítica de la landing.**
- **El emparejamiento abierto del hub público:** después de ALB-304 y de la prueba real de ALB-330.
