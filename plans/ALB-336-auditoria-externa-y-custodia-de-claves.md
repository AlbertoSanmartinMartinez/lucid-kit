# ALB-336 · Seguridad: auditoría externa de la criptografía y de `ts-mls`, y custodia de las claves del servicio alojado

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-336
- **Rama:** `info/alb-336-seguridad-auditoria-externa-de-la-criptografia`
- **Prioridad:** Low
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada contratado ni implementado.

## El problema

1. **Nadie de fuera ha revisado la criptografía.** Las piezas son las estándar de Node, pero cómo se combinan (MLS, HPKE, delegaciones, el registro de transparencia, el relevo) solo lo ha revisado quien lo escribió.
2. **`ts-mls`, que pone MLS, no está auditada** y la mantiene una sola persona.
3. **Las claves viven en ficheros** con permisos `0600`: la del agente, la del hub, y la del verificador con su secreto. Para quien monta su propio hub vale. Para un hub ofrecido como servicio, no.

## Decisiones del dueño

| Pregunta | Decisión |
|---|---|
| Cuándo se audita | **El alcance se escribe ahora; se contrata después,** cuando estén cerrados los issues de prioridad alta, y antes de vender nada a empresas. El presupuesto y el auditor los decide el dueño |
| `ts-mls` | **Se mantiene, y entra en la auditoría.** Si el informe la desaconseja, se sustituye entonces |
| Firmar con una clave guardada en un KMS | **Cuando lo pida el servicio alojado.** Aquí queda anotado |

## Lo que se hace ahora: el alcance de la auditoría

Un documento, `docs/AUDIT-SCOPE.md`, en inglés: es lo que se manda a los auditores para pedir presupuesto, y lo que se les entrega. Sale de lo que ya está escrito en el HANDOFF y en la especificación (ALB-351).

| Apartado | Qué dice |
|---|---|
| Qué protege el proyecto y de quién | El modelo de amenaza: el hub no es de fiar para la autoría ni para el contenido; lo que escribe otro agente es dato |
| Qué se audita | Las firmas y sus contextos; las peticiones firmadas; HPKE; MLS, con `ts-mls` y el único fichero que la toca; quién puede cambiar un grupo; el registro de transparencia, su mapa y los testigos; las delegaciones, las instancias y el relevo; la federación |
| Qué no | El servicio alojado, que tiene su repositorio; la landing |
| Lo que ya se sabe | Lo que el proyecto declara como no verificado, tal cual está en el README, y los fallos que encontraron las revisiones anteriores con su arreglo |
| Qué se entrega | El código en una etiqueta fija, la especificación, los vectores de prueba, los tests de ataque y los guiones de mutaciones |
| Qué se pide | Un informe con hallazgos clasificados, y una segunda pasada sobre los arreglos |

**Cuándo se contrata:** con el código estable. En concreto, después de ALB-346 (que renombra el protocolo entero), de los issues del almacén y de ALB-304. Auditar antes sería pagar por revisar código que va a cambiar.

## Lo que pasa después, y no es de este plan

- **Cada hallazgo del informe, un issue.**
- **La decisión sobre `ts-mls`,** escrita con el informe en la mano: mantenerla o sustituirla. Hay un experimento de interoperabilidad con otra implementación en `experiments/mls-interop/`, que es el punto de partida si toca sustituirla.
- **La web y el README** siguen diciendo que no hay auditoría hasta que la haya.

## Custodia de claves: lo que queda anotado

Para cuando el servicio alojado lo pida:

- **Qué haría falta:** que el hub y el verificador firmen a través de una interfaz, con la clave en un KMS o en un almacén de secretos, sin sacarla de ahí. El fichero seguiría siendo la opción de quien monta su propio hub.
- **Por qué no es trivial:** firmar con un KMS es esperar una respuesta de fuera. Hoy el hub firma en el acto, y hay sitios donde eso se da por hecho.
- **Lo que no cambia:** las claves de los agentes son de sus dueños y no van a ningún KMS del servicio.

## Tests

Ninguno: este plan no cambia código. El documento de alcance se revisa como documentación.

## Documentación

- `docs/AUDIT-SCOPE.md`, nuevo.
- `docs/HANDOFF.md`: sección nueva con las tres decisiones.
- `SECURITY.md` (ALB-352) ya dice que el proyecto no ha pasado una auditoría: se actualiza cuando la pase.

## Lo que hace el dueño

- Aprobar el alcance.
- Pedir presupuesto, elegir auditor y decidir la fecha.

## Fuera de este issue

- **La auditoría en sí,** y sus arreglos.
- **La interfaz de firmante y el KMS.**
- **Un programa de recompensas por fallos.**
