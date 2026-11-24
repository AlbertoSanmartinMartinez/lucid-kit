# ALB-338 · SDK: los eventos recibidos no se comprueban por frescura, y la deduplicación solo vive en memoria

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-338
- **Rama:** `info/alb-338-seguridadmedium-sdk-los-eventos-recibidos-no-se`
- **Prioridad:** Medium (seguridad)
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.
- **Va después de ALB-306:** lo recordado se guarda en el estado del agente, que con ese issue es de un solo proceso.

## El problema

El SDK comprueba la firma de cada evento, pero no mira cuándo se firmó ni si ya lo entregó antes de un reinicio. Lo que recuerda de lo entregado es una lista en memoria de 5.000 entradas, que se pierde al reiniciar.

Un hub malicioso puede volver a entregar eventos antiguos, auténticos y bien firmados, a un agente que se reinició o que ya vio más de 5.000. Si el agente actúa por lo que lee (una orden, un pago, una aprobación), lo repite. El proyecto parte de que el hub no es de fiar: esto es un hueco frente a su propio modelo.

Los mensajes sobre MLS no están afectados: una clave usada se borra, y el mismo mensaje no se abre dos veces.

## Decisión del dueño

**Una ventana de 30 días,** configurable. El agente recuerda en disco lo que entregó en ese tiempo, y rechaza los eventos firmados hace más.

El issue proponía 10 minutos. Se descartó: tiraría todo lo que un agente lee al volver tras unas horas desconectado, y el buzón existe justo para eso.

Las dos reglas van juntas: no se puede recordar para siempre, así que lo que es más viejo que lo recordado no se puede distinguir de una reentrega y se rechaza.

## Cambios

En `src/sdk/index.mjs`, para lo que no va sobre MLS: los eventos de topics públicos, los mensajes sellados con HPKE y los de topics con clave de topic.

### 1. Frescura

`maxEventAgeMs`, opción nueva de `AgentClient` (30 días por defecto). Se rechaza un evento cuya hora firmada (`event.time`) es:

- más vieja que la ventana, o
- más de 10 minutos posterior al reloj del agente.

Sale como los demás mensajes que no se entregan: por `onError` o en `errors`, con un código nuevo, `stale_event`.

### 2. Lo ya entregado, recordado en disco

- **Dónde:** en el estado del agente, junto al de MLS. Por cada evento se guarda un resumen corto de su emisor y su identificador, agrupado por la hora en que se firmó.
- **Cuándo se guarda:** después de que la aplicación ha recibido el mensaje y antes de confirmarlo en el hub. Así una caída nunca pierde un mensaje. A cambio, una reentrega cabe si el proceso muere justo en ese hueco, y se dice.
- **Cuándo se olvida:** al salir de la ventana, grupo a grupo. Nunca todo de golpe, que es lo que pasa hoy al llegar a 5.000.
- **Un cliente sin estado en disco** aplica las mismas reglas en memoria, y lo pierde al reiniciar. Se dice en la documentación.

### 3. Leer el historial no es recibir

`topicHistory()` trae a propósito eventos pasados de un topic público. Sigue comprobando la firma de cada uno, y no les aplica ni la ventana ni lo recordado: no entrega nada, y quien lo llama sabe que lee el pasado.

### 4. Servidor MCP y CLI

- `hub_inbox` dice, con una línea suya, cuántos mensajes se descartaron por viejos o por repetidos.
- El CLI guarda ya su estado en disco: `agenthub inbox`, que es un proceso nuevo cada vez, deja de aceptar lo que el anterior ya entregó.

## La garantía, tal como queda

| | Sobre MLS | Lo demás |
|---|---|---|
| Reentrega tras un reinicio | No se puede | Se rechaza, dentro de la ventana |
| Eventos más viejos que la ventana | No aplica | Se rechazan |
| Reentrega si el proceso muere entre entregar y guardar | No se puede | Cabe |

La protección completa contra la reentrega solo la da MLS.

## Tests

En `test/hub.test.mjs`, `test/e2e.test.mjs` y `test/private.test.mjs`, con un hub de prueba que hace de malicioso y con el reloj inyectado:

1. **Reentrega tras un reinicio:** el hub manda el mismo evento a un cliente nuevo sobre el mismo estado; se rechaza.
2. **Un evento firmado hace 31 días** se rechaza; uno de hace 29, se entrega.
3. **Un evento con hora del futuro** se rechaza.
4. **El evento 5.001** no hace olvidar el primero.
5. **Lo que sale de la ventana se olvida,** y solo eso.
6. **Un agente que vuelve a los tres días** lee su buzón entero.
7. **Los tres tipos:** público, sellado con HPKE y con clave de topic.
8. **El historial** de un topic se lee aunque sea más viejo que la ventana, y leerlo no cuenta como entregado.
9. **Sin estado en disco,** las mismas reglas en memoria.
10. **`hub_inbox`** cuenta lo descartado sin repetir nada de su contenido.

## Documentación

- `README.md`: la tabla de arriba, la opción nueva y el código nuevo. Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva con la decisión y el porqué de los 30 días.
- `CLAUDE.md`, regla «El hub no es de fiar»: tampoco para decidir qué es nuevo.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`: sus agentes leen buzones con procesos nuevos cada vez.

## Fuera de este issue

- **Que el autor ponga una caducidad a su evento.** Hoy un evento solo lleva la hora en que se firmó.
- **Que el hub deje de guardar** lo que ningún cliente va a aceptar ya: sus buzones no miran la edad de lo que guardan.
