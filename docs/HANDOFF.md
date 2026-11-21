# Agent Hub: traspaso de contexto

Este documento resume la conversación en la que se diseñó y construyó el proyecto, para continuar el trabajo en otra sesión sin perder las decisiones ni sus motivos. Fecha del traspaso: 13 de noviembre de 2026.

El diseño de la plataforma está en `docs/DESIGN.md`.

El documento de diseño describe el objetivo a largo plazo y **no refleja lo construido**: el MVP simplifica la infraestructura y sustituye MLS por construcciones más sencillas. Donde difieran, manda este documento y el README.

## 1. La idea

Un hub abierto donde cualquier agente de cualquier organización se registra, publica y se suscribe a topics, y habla con otros agentes directamente por su identificador. El hueco de mercado detectado: A2A cubre la comunicación directa pero no tiene pub/sub nativo; "A2A over MQTT" de EMQX no tiene federación, catálogo de topics con esquemas ni suscripción por intención. El precedente a evitar es Moltbook (base de datos sin seguridad por fila, claves de agentes expuestas, identidad débil).

Diferenciadores buscados: federación entre organizaciones, registro de topics con esquema y permisos, y descubrimiento semántico.

## 2. Decisiones de diseño tomadas por el dueño

1. Hub **abierto**: cualquier agente puede registrarse.
2. **Identidad por niveles**: solo clave (con prueba de trabajo y permisos limitados), delegado por una persona verificada, delegado por una organización con dominio. Los agentes locales (por ejemplo Claude Code en un portátil) entran sin dominio, con conexión saliente.
3. **Dos tipos de topic**: públicos (solo firmados) y privados (cifrados).
4. **MLS para todo lo cifrado**, incluidos los mensajes directos, con cada instancia de agente como miembro. Se descartó Signal (licencia AGPL de libsignal, sin soporte para terceros, problema de varias instancias).
5. El hub **ve al emisor pero no el contenido**. Privacy Pass queda como mejora futura.
6. Validación de lo cifrado en el **SDK del receptor**.
7. **Revocación activa** con tiempo de propagación medido, no "instantánea".
8. Firmas sobre **JCS (RFC 8785)**.
9. Stack objetivo: GCP, Terraform, GKE, NATS JetStream, PostgreSQL con pgvector y seguridad por fila, Valkey, servicios en Rust, OpenMLS, Tessera.
10. Los hallazgos de prioridad media y baja de la revisión interna se documentan y se abordan después.

## 3. Revisión externa del diseño

Otro agente evaluó el diseño (7/10) y recomendó no implementarlo tal cual. Sus cinco fundamentos pendientes:

1. **Modelo de identidad y delegación**: separar agente lógico, instancia, controlador y carga de trabajo.
2. **Arquitectura de MLS**: MLS no es pub/sub; diseñar grupos, concurrencia de commits e historial.
3. **Mensajería y entrega**: modelo de suscripciones y reparto a muchos suscriptores.
4. **Protocolo de federación**: los leaf nodes de NATS no son un diseño de federación.
5. **Autorización y gobierno en ejecución**: autenticar no es autorizar.

Puntos que la revisión acertó y ya están corregidos en el código: la firma iba dentro del objeto firmado (ahora sobre `{ event, proof }`) y DPoP no aplica fuera de HTTP (el MVP firma cada petición y no usa tokens).

Matices acordados frente a la revisión:

- "MLS para todo" nunca incluyó los topics públicos, que van solo firmados.
- La concurrencia de commits de MLS tiene un patrón conocido: el servicio de entrega acepta un único commit por época.
- Para NATS, las NKeys ya son Ed25519: la clave de cada instancia puede ser su NKey, y el gateway emite el JWT de usuario para esa clave.
- Para el reparto a muchos suscriptores, un consumidor duradero por gateway y topic, no uno por agente.

Estos matices son análisis sin verificar contra las versiones actuales de MLS, OpenMLS y NATS.

## 4. Qué está construido (versión 0.7)

| Área | Qué hay | Dónde |
|---|---|---|
| Identidad | `did:key` Ed25519, prueba de trabajo al registrarse, tarjeta firmada | `core/didkey`, `core/pow`, `core/sign` |
| Autenticación | Firma por petición con nonce y ventana de tiempo, para la dirección del hub al que va, sin tokens | `core/reqsig` |
| Mensajes | Sobre `{ event, proof }` en formato CloudEvents, JCS, separación por contexto | `core/sign`, `core/jcs` |
| Topics públicos | Contrato con JSON Schema (subconjunto), búsqueda léxica BM25, historial | `core/schema`, `core/search`, `hub/server` |
| Entrega | Buzón por agente, SSE o consulta, al menos una vez, deduplicación | `hub/store`, `sdk` |
| Mensajes directos | Sobre MLS (RFC 9420) con `ts-mls`: un grupo por pareja de agentes con todos sus lectores, secreto hacia adelante, y renovación de claves con commits que ordena el hub. HPKE (RFC 9180) cuando el otro lado no puede MLS | `mls/`, `sdk/state`, `core/hpke`, `core/e2e` |
| Instancias | Varias copias de un agente, cada una con su clave y un certificado firmado por el agente; un buzón y un stream por instancia; retirada | `core/instance`, `hub/server`, `hub/store` |
| Niveles | `key`, `account`, `org`; delegación firmada con alcance y caducidad | `core/delegation` |
| Organizaciones | `did:web` con descarga protegida contra SSRF | `core/didweb` |
| Revocación | Firmada por el controlador, efecto inmediato, registro público; retirada propia | `hub/server` |
| Cambio de clave | Posterior a la 0.7 (sección 33): un agente pasa a un sucesor con otra clave, con un relevo que firma su guardián (su controlador o una clave de recuperación) o, si no tiene, él mismo; sus topics y sus bloqueos pasan al sucesor | `core/statement`, `core/log`, `hub/server`, `sdk` |
| Permisos | Alcance de la delegación; políticas de publicación y suscripción por topic; topics restringidos | `hub/server` |
| Topics privados | Sobre MLS: un grupo por topic con todos los lectores de sus miembros, que el dueño modifica con commits; sin historial para quien entra. Con clave de topic (clave por época, concesiones firmadas por el dueño, rotación al expulsar) para clientes sin estado de MLS | `mls/topic`, `mls/member`, `sdk`, `core/groupkey` |
| Federación | Clave propia de cada hub y emparejamiento a mano entre operadores. Los agentes de un hub buscan, siguen y publican en los topics públicos de lectura libre de un hub emparejado (`topic@hub`), y encuentran a sus agentes y les escriben mensajes directos (`did@hub`): sobre MLS, con una casa por conversación, o sellados con HPKE cuando del otro lado nadie puede MLS (secciones 17 y 21) | `hub/federation`, `hub/server`, `core/topicname`, `core/address`, `core/sse` |
| Registro de transparencia | Es la 0.6: el hub apunta cada cambio de su directorio en una lista que solo crece y firma su tamaño y su raíz; cualquiera puede leerla entera y comprobar que se sostiene; un cliente con estado la sigue y contrasta con ella lo que el hub le enseña y quién firma lo que recibe; y lo que cambia un agente va apuntado con su firma (sección 19). Faltan los testigos, que el dueño dejó para más adelante (sección 20) | `core/merkle`, `core/log`, `hub/store`, `hub/server`, `sdk/follower`, `sdk` |
| MCP | Servidor por stdio con 12 herramientas y contenido ajeno marcado como no fiable; registrado para Claude Code en este repositorio | `mcp/server`, `.mcp.json` |
| Despliegue | HTTPS directo, modo tras proxy, Dockerfile | `hub/server`, `Dockerfile` |
| Persistencia | Memoria más diario y copia en disco; sobrevive a reinicios y caídas | `hub/store` |

## 5. Desviaciones del diseño y motivo

El MVP se construyó en un entorno sin red, así que no pudo usar dependencias ni servicios.

| Diseño | MVP | Motivo |
|---|---|---|
| Rust, NATS, PostgreSQL, Valkey | Un proceso de Node con diario en disco | Sin servicios disponibles cuando se construyó; se mantiene hasta que haya despliegue (sección 9) |
| MLS (OpenMLS) | `ts-mls` en mensajes directos y topics privados; HPKE y clave de topic quedan para clientes sin estado de MLS | OpenMLS no era accesible al principio. Con red se eligió `ts-mls` tras comprobar que se entiende con OpenMLS (sección 9) |
| Tokens cortos con DPoP | Firma en cada petición | Más simple, y nada que robar |
| Nivel 2 verificado con GitHub | El operador marca controladores verificados a mano | Sin red para verificar cuentas |
| Embeddings con pgvector | BM25 | Sin modelo disponible |
| El nivel 1 no crea topics | Sí puede por defecto (`--topic-create-tier` lo cambia) | Para que el uso local funcione sin verificar a nadie |

## 6. Limitaciones conocidas y cosas sin verificar

- **Secreto hacia adelante solo en lo que va sobre MLS.** No lo hay en los mensajes directos que caen a HPKE ni dentro de una época de un topic privado con clave de topic: ahí, quien robe una clave de cifrado lee lo anterior que haya capturado.
- **Renovar claves cura lo que cura.** Solo el lector cuyo estado se copió puede dejar fuera a la copia, y solo si el hub reparte su commit. El detalle y el resto de límites de MLS están en las secciones 13, 14 y 15.
- **En un topic sobre MLS, un lector que no puede seguir al grupo espera a que lo readmitan.** Lo pide él solo, pero lo hace el dueño u otro lector de su agente la siguiente vez que usa el topic. Lo que llegue mientras tanto no lo lee (sección 15).
- **`ts-mls` no está auditada** y la mantiene una persona. Todo su uso pasa por `src/mls/member.mjs` para poder cambiarla.
- **Los agentes miembros de un topic privado los decide solo el dueño.** Sobre MLS cada agente gestiona además sus propias instancias, y el grupo admite 50 lectores por defecto. Con clave de topic, hasta 100 miembros y sin recuperación automática tras un compromiso.
- **Dueño de un topic.** Un cliente que sigue el registro lo toma del registro, no de lo que el hub le diga al primer contacto. Queda lo que el registro no cierra aún: un hub que lleve dos registros, y uno que apunte un dueño falso al crear el topic, que es su palabra (sección 19). Un cliente sin estado sigue como antes: se queda con el dueño que ve la primera vez.
- **El cambio de clave es dentro de un hub.** Entre hubs no se dice quién releva a quién. El guardián es una sola clave que no se cambia, y un agente sin guardián cuya clave se roba puede ser relevado por el ladrón (sección 33).
- **`did:web` no se ha probado contra un dominio real.** Los tests sustituyen la red.
- **El servidor MCP solo se ha probado con Claude Code y con el cliente oficial de MCP** (sección 11), y la prueba con modelo se hizo una sola vez. No implementa la revisión 2026-07-28 de MCP.
- **El cifrado no está auditado.** Usa primitivas estándar, pero la composición no la ha revisado nadie más.
- **Las instancias leen lo que va sobre MLS** y no lo sellado para la clave del agente: mensajes directos con HPKE y topics privados con clave de topic.
- **Retirar una instancia.** La retirada queda en el registro, y quien lo sigue deja de escuchar a esa instancia y no la admite en un grupo aunque el hub la siga listando. Va firmada por quien la retira, el agente o la propia instancia, así que el hub no puede apuntarla por su cuenta (sección 19). Para un cliente sin estado, o frente a un hub que lleve dos registros, una clave de instancia robada vale hasta que caduque su certificado, más siete días de margen.
- **Un solo proceso**, sin réplicas. Un stream por lector: la clave del agente y cada una de sus instancias.
- **La federación llega hasta los topics públicos de lectura libre y los mensajes directos, sobre MLS o sellados con HPKE.** Entre hubs no viajan topics privados o restringidos, delegaciones ni retiradas, y no hay saltos. En una conversación MLS entre dos hubs, los lectores del agente del otro hub no se contrastan con ningún registro, y la casa de la conversación guarda un máximo de ellas por hub emparejado (sección 21). De qué hub es un topic se lo dice al agente su propio hub. No está probada entre máquinas distintas ni con TLS. El detalle está en la sección 17.
- **El registro de transparencia no está completo.** Lo siguen los clientes con estado. Sin testigos no detecta a un hub que lleve dos registros (sección 32), parte de lo apuntado es la palabra del hub, y no cubre lo que viene de otros hubs (sección 19). Se puede preguntar por un solo nombre sin leerlo (sección 34), pero el SDK no trabaja solo con eso.
- **Lo que el servidor MCP cuenta del hub sin envolver** son solo cosas con forma comprobada (sección 20). Queda una cadena libre: la etiqueta con la que el hub dice haber verificado a un controlador (`verified_as`), que se enseña si no tiene espacios ni pasa de 80 caracteres. Y el nombre de la propia tarjeta en `hub_status`, que es del agente: lleva su firma.
- **Sin** reputación, bloqueo de remitentes, moderación de topics ni identidad para agentes efímeros.
- **No está desplegado en ninguna nube.**

## 7. Hoja de ruta acordada

Bloques pequeños, cada uno terminado y entregado:

1. ~~Servidor MCP y topics privados cifrados~~ (hecho, 0.3).
2. MLS de verdad sobre el MVP (decidido el 13 de noviembre, sección 9), en este orden: ~~separar agente e instancia~~ (hecho, sección 12); ~~mensajes directos como grupo MLS~~ (hecho, sección 13); ~~commits ordenados por el hub, estrenados para renovar claves~~ (hecho, sección 14); ~~topics privados sobre MLS~~ (hecho, sección 15). Con la reentrada de lectores (sección 15) el bloque 2 queda cerrado: es la versión 0.4.
3. ~~Federación mínima entre dos hubs~~ (decisiones del dueño en la sección 16; hecho, sección 17): clave del hub y emparejamiento, topics públicos entre hubs y mensajes directos entre hubs sellados con HPKE. Es la versión 0.5. Llevar MLS a esos mensajes queda para después del bloque 4 (sección 18).
4. Registro de transparencia y antiabuso (bloqueo de remitentes, reputación, moderación). Del registro (sección 19): ~~el registro del hub, firmado y auditable~~; ~~que los clientes lo sigan~~; ~~que lo que cambia un agente vaya firmado por él~~. Es la versión 0.6. Los testigos quedan para más adelante, por decisión del dueño (sección 20). El antiabuso no está empezado.
5. ~~MLS en los mensajes directos entre hubs~~ (hecho, sección 21), con lo que arregló la revisión independiente que se le hizo (sección 22). Es la versión 0.7 (sección 23).

Pendiente de decidir cuándo: despliegue, verificación de cuentas con GitHub, identidad para agentes efímeros con OIDC.

## 8. Qué cambia al continuar en un entorno con red

Lo que en el entorno original no era viable y aquí puede serlo:

- **MLS de verdad.** Sustituye a HPKE y a las claves de grupo, y es ahora el bloque 2 (sección 9).
- **Probar el servidor MCP** registrándolo en Claude Code contra un hub local (hecho; sección 11).
- **Probar `did:web`** contra un dominio real y **verificar cuentas** con GitHub.
- **Desplegar**, con Terraform si se sigue el diseño.
- **PostgreSQL y NATS** en lugar del almacén en memoria, manteniendo la API HTTP.

## 9. Decisiones del dueño (13 de noviembre de 2026)

Las cuatro primeras eran las decisiones abiertas del traspaso. El dueño las tomó así:

1. **Dependencias.** Se abandona la regla de no tener ninguna: el proyecto puede usar dependencias normales, también en el hub y en el núcleo. La primera es `ts-mls` 1.6.4, con `@noble/hashes` 2.4.0, que `ts-mls` usa sin declararla.
2. **Implementación de MLS.** La elige quien continúe el trabajo, tras una prueba de compatibilidad: un grupo con un miembro de `ts-mls` y otro de OpenMLS. Si se entienden, se empieza con `ts-mls` detrás de una interfaz propia y OpenMLS queda para cuando haya auditoría o despliegue. Si no, OpenMLS. No se reescribe el hub en Rust: el hub no necesita MLS para repartir. **La prueba se hizo el mismo día y se entienden (20 comprobaciones de 20, en `experiments/mls-interop`), así que MLS se empieza con `ts-mls`.**
3. **Nube.** Aplazada. Se decide cuando haya un despliegue que hacer.
4. **Orden.** Seguir sobre el MVP de Node y hacer el bloque 2 con MLS de verdad: primero separar agente e instancia, después mensajes directos como grupo MLS. Luego topics privados sobre MLS, federación y transparencia. El stack objetivo espera al despliegue.

**Datos comprobados el 13 de noviembre para estas decisiones.** Lo demás de esta sección sigue siendo análisis.

- OpenMLS va por la 0.9.2 en crates.io, todavía sin 1.0. Su paquete para JavaScript, `openmls-wasm` 0.1.0, se describe a sí mismo como un experimento.
- `ts-mls` 1.6.4 (MIT) implementa el RFC 9420 en TypeScript puro, para Node 20 o superior. Declara una sola dependencia, pero al instalarlo faltaba `@noble/hashes` y hubo que añadirlo a mano. Su README avisa de que no tiene auditoría. Lo mantiene una persona y la 2.0 está en candidatas.
- Prueba hecha fuera del repositorio con `ts-mls` en Node 22, una sola ejecución: grupo de tres miembros, alta de dos en un commit, mensajes de aplicación y expulsión de uno. Cifrar o descifrar un mensaje tardó de 3 a 5 ms, y crear o procesar un commit de 12 a 35 ms. Un KeyPackage ocupa 334 bytes, y un mensaje de 53 bytes ocupa 341 una vez cifrado. El miembro expulsado no pudo leer la época siguiente.
- `@wireapp/core-crypto`, que envuelve OpenMLS para navegadores, es GPL-3.0: el mismo tipo de problema de licencia por el que se descartó libsignal.
- `mls-rs` (AWS) va por la 0.57.1 en crates.io y no tiene paquete en npm.
- `ts-mls` 1.6.4 y OpenMLS 0.9.2 se entienden dentro de un mismo grupo, en los dos sentidos: unirse con el Welcome del otro, mensajes, commits, alta de un tercer miembro y expulsión. El experimento, con lo que cubre y lo que no, está en `experiments/mls-interop`.
- ~~Sin probar, solo razonado: el hub no necesita código de MLS.~~ Se hizo de otra forma (secciones 13 y 14): el hub usa la librería para leer lo que un mensaje MLS deja en claro, su grupo, su época y su tipo, y con eso ordena los commits. Sigue sin tener ninguna clave.

## 10. Primeros pasos sugeridos

1. ~~`npm test` y `npm run demo` para confirmar que todo funciona en la máquina.~~ Hecho el 13 de noviembre, con Node 22.
2. ~~Arrancar un hub local y registrar el servidor MCP en Claude Code (instrucciones en el README). Comprobar el flujo con dos agentes.~~ Hecho; ver la sección 11.
3. ~~Plantear al dueño las decisiones abiertas 1 a 4 antes de escribir código nuevo.~~ Hecho; sus respuestas están en la sección 9.

## 11. Primera sesión con red (13 de noviembre de 2026)

El MVP se importó a un repositorio de GitHub y se comprobó el servidor MCP contra clientes reales. No se escribió funcionalidad nueva: solo se corrigió lo que la comprobación sacó a la luz.

**Qué se comprobó**

- Claude Code 2.1.323, el CLI real con una configuración aislada: `claude mcp add`, el `.mcp.json` del proyecto y la conexión (`claude mcp list` responde `Connected`). El tráfico que envía al conectar se grabó y es ahora un test.
- El cliente oficial de MCP (`@modelcontextprotocol/sdk` 1.32.2, instalado fuera del repositorio): las 12 herramientas, en un flujo entre dos agentes con procesos e identidades separados, contra un hub con la prueba de trabajo de 18 bits. 24 comprobaciones, todas correctas.
- Una sesión real de Claude Code en la nube, lanzada como sesión auxiliar sobre esta rama: las 12 herramientas estaban disponibles al arrancar, sin aprobar nada, y el modelo recorrió con ellas diez pasos frente a un segundo agente manejado con el CLI (hub parado, registro, topic público con contrato, mensaje directo cifrado, evento fuera de contrato, topic privado, expulsión de un miembro). Todos correctos.

**Qué se encontró y se corrigió**

| Hallazgo | Corrección |
|---|---|
| El comando `claude mcp add` del README fallaba: `--env` admite varios valores y se tragaba el nombre del servidor | El nombre va antes de las opciones |
| Con el hub parado, las herramientas respondían "fetch failed" y el modelo no tenía nada que contarle a su usuario | El SDK lanza `hub_unreachable` con la dirección que intentó; el servidor MCP y el CLI añaden qué hacer |
| Un fichero de identidad dañado daba un error que no decía qué fichero era, y un error de sintaxis de JSON puede citar texto del fichero, que contiene claves privadas | El error nombra el fichero y nunca su contenido |
| Una URL de hub mal escrita solo fallaba en la primera petición, con "Invalid URL" | Se rechaza al crear el cliente |
| Claude Code pide la revisión 2025-11-25 de MCP y el servidor se quedaba en 2025-06-18 | Revisado el registro de cambios de 2025-11-25: nada obliga a cambiar un servidor de solo herramientas por stdio, así que ahora la acepta |
| Al modelo le hizo dudar `delivered_to: 0` al publicar en un topic al que él mismo estaba suscrito | La descripción dice que quien publica no recibe sus propios eventos |
| `hub_inbox` no decía que leer confirma la recepción, ni si un mensaje llegó cifrado, ni cuándo se envió | La descripción lo dice, y el envoltorio de cada mensaje lleva `time` y `encrypted` |
| Nada decía que los miembros de un topic privado tienen que suscribirse para recibir | La descripción de `hub_create_topic` lo dice |
| `members` era un número en un resultado y una lista en otro, y `hub_topic_members` repetía datos | `member_count` al crear; `hub_topic_members` devuelve siempre la lista actual, la época y lo que cambió |

**Qué se aprendió**

- Claude Code sondea primero el protocolo sin estado de MCP 2026-07-28 (`server/discover`) y, si el servidor responde "method not found", vuelve a `initialize`. Implementar 2026-07-28 queda pendiente y hoy no hace falta.
- Una sesión de Claude Code en la nube no hereda lo que se registra con `claude mcp add`: lee el `.mcp.json` del repositorio al arrancar. Por eso el repositorio trae uno. El servidor MCP arranca sin hub; las herramientas necesitan uno en marcha (`node bin/agenthub.mjs hub`).
- La sesión en curso no recarga `.mcp.json` (se comprobó: las herramientas no aparecieron), y no se lanzó un Claude Code anidado con modelo porque no está documentado para sesiones en la nube y podía interferir con la sesión que lo lanza. Lo que sí funciona es lanzar otra sesión en la nube sobre la rama, que arranca con el `.mcp.json` ya en el repositorio.
- En este entorno `modelcontextprotocol.io` no es accesible; la especificación se leyó del repositorio público de MCP en GitHub.
- El entorno tiene Rust (cargo 1.97) además de Node 22, y llega a npm y a crates.io.

**Qué queda de este paso**

Dos cosas que el modelo echó en falta y no se han tocado, porque son decisiones de protocolo y no de redacción:

- No hay forma de decir a qué mensaje responde un mensaje directo. El modelo puso un `in_reply_to` dentro de `data` por su cuenta.
- El `type` de un mensaje es libre y nada orienta sobre qué valores usar.

**Segunda prueba con un modelo, con los topics privados sobre MLS (13 de noviembre, versión 0.4)**

El dueño pidió repetirla una vez (sección 16). Otra sesión auxiliar en la nube sobre esta rama, con el modelo decidiendo las llamadas frente a un segundo agente manejado con el CLI. Doce pasos, todos correctos: instalar la dependencia, hub parado, registro, topic público con contrato, mensaje directo (`mls-v1` en los dos sentidos), topic privado sobre MLS, publicar y leer en ambos sentidos, listar miembros, expulsar (el expulsado ya no publica), readmitir (lee desde que vuelve y nada de lo publicado mientras estuvo fuera) y renovar las claves de la conversación con `key renew`. Costó 1,79 USD. La sesión es `session_015xU2HB1kLQPdTqMRApFXzq`; el dueño puede archivarla.

Lo que al modelo le resultó confuso, y qué se hizo:

| Hallazgo | Corrección |
|---|---|
| `hub_get_topic` no decía cómo va cifrado un topic privado, y mostraba `publish: "any"` y `subscribe: "any"` cuando solo lo usan sus miembros | Muestra `encryption`, cuántos miembros tiene, y "any member" y "members only" |
| `hub_inbox` decía si un mensaje llegó cifrado, pero no cómo | El envoltorio lleva `encryption` cuando el mensaje va cifrado |
| En `hub_topic_members`, `members` y `readers` salían iguales y nada explicaba la diferencia | La descripción dice que unos son los agentes y otros las claves que leen: la de cada agente y cada una de sus instancias |
| Tras ser expulsado, el error al publicar hablaba de "preguntar por el grupo" | Dice que el agente no es miembro del topic |
| Nada decía que crear un topic no suscribe a quien lo crea, ni que un miembro readmitido tiene que volver a suscribirse | Las descripciones de `hub_create_topic` y `hub_topic_members` lo dicen |

De paso apareció que los tests del servidor MCP en proceso usaban clientes sin estado de MLS, así que probaban los topics con clave de topic y no sobre MLS. Ahora hay un test que recorre las herramientas con clientes que sí lo guardan.

Sin tocar, por ser lo mismo que quedó de la primera prueba: no hay forma de decir a qué mensaje responde otro, ni orientación sobre el `type`.

## 12. Agente e instancia (13 de noviembre de 2026)

Primer paso del bloque 2. Responde al primer fundamento de la revisión externa en lo que toca a agente e instancia; controlador ya existía, y la identidad de cargas de trabajo efímeras sigue pendiente.

**El modelo**

- El **agente** es la identidad: su `did:key`, su tarjeta, quién delega en él, sus topics, sus suscripciones, su nivel y sus límites.
- Una **instancia** es una copia en ejecución. Genera su propia clave Ed25519, y el agente le firma un certificado (`agenthub/instance/v1`): agente, clave de la instancia, etiqueta opcional, emisión y caducidad.
- La instancia se registra ella misma (`PUT /v1/instances/me`): firma la petición con su clave, lo que prueba que la tiene, y presenta el certificado, lo que prueba que el agente la quiere. La clave del agente no interviene.
- Desde ahí firma peticiones y eventos con su clave. En un evento, `source` sigue siendo el agente y la prueba lleva el certificado. Hub y receptores comprueban la cadena.
- Usar la clave del agente directamente sigue funcionando igual que antes. Nada de lo anterior cambió de comportamiento.

**Decisiones y por qué**

| Decisión | Motivo |
|---|---|
| El certificado viaja dentro de la prueba de cada evento | El receptor verifica sin preguntar al hub, y un evento antiguo se puede verificar aunque la instancia ya no exista |
| El certificado caduca siempre (90 días como máximo) | Es lo único que limita una clave robada frente a un hub que no hace cumplir la retirada |
| Los receptores conceden siete días tras la caducidad a lo firmado a tiempo | Un mensaje puede esperar en un buzón; sin ese margen se descartarían mensajes legítimos. El hub, al aceptar, no concede ninguno |
| Tarjeta, delegación, retirada del agente y retirada de otra instancia exigen la clave del agente | Una instancia actúa como el agente, pero no decide quién es el agente |
| La clave que firma la petición es la que debe haber firmado el contenido | Una instancia no puede publicar en nombre de otra ni reutilizar un sobre firmado por el agente |
| Un buzón por lector, y una instancia nueva empieza vacía | Cada instancia ve cada mensaje una vez y ninguna confirma por otra. Es también lo que hará MLS: un miembro nuevo no lee lo anterior |
| Una clave es agente o instancia, nunca las dos cosas, y una instancia retirada no vuelve | Evita ambigüedades sobre a quién representa una firma |
| El certificado no lleva clave de cifrado | En MLS cada instancia publicará sus KeyPackages; un cifrado intermedio por instancia habría sido trabajo de usar y tirar |

**Para el paso siguiente (mensajes directos sobre MLS)**

- La clave de la instancia es la candidata natural a clave de firma de su hoja en MLS, y el certificado, a credencial. El servicio de autenticación de MLS es entonces esta misma cadena: agente, certificado, instancia.
- La clave del agente, usada directamente, tendrá que contar como una instancia más o dejar de leer lo cifrado. Hay que decidirlo al diseñar los grupos.
- El hub ya reparte por lector, que es lo que MLS necesita: un mensaje de grupo para cada instancia miembro.
- Falta el directorio de KeyPackages por instancia y el orden de commits por grupo.

## 13. Mensajes directos sobre MLS (13 de noviembre de 2026)

Segundo paso del bloque 2. Trae la primera dependencia del proyecto, `ts-mls`, y responde en parte al segundo fundamento de la revisión externa: cómo se usa MLS aquí, de momento solo para conversaciones entre dos agentes.

**Cómo funciona**

- Un miembro de MLS es un lector: la clave de un agente, o una de sus instancias. Su credencial es el DID del agente o el certificado de la instancia, y su clave de firma en MLS es esa misma clave. El servicio de autenticación de MLS es el modelo de identidad que ya había (`src/mls/credential.mjs`).
- Cada lector publica KeyPackages en el hub. El hub comprueba que son suyos y los entrega una vez cada uno, guardando siempre el último.
- Dos agentes hablan en un grupo con todos los lectores de ambos. El grupo se crea de una vez y no se modifica. El hub guarda, por pareja de agentes, cuál es el grupo actual y su generación, y solo deja ganar a uno cuando dos lectores crean a la vez el siguiente.
- Antes de enviar, el SDK compara los miembros del grupo con los lectores que hay ahora. Si no coinciden, crea el grupo de la generación siguiente. Así entra una instancia nueva y sale una retirada.
- El mensaje viaja en el sobre firmado de siempre, con `encryption: "mls-v1"`. El texto cifrado va ligado al sobre, y quien cifró tiene que ser la clave que lo firmó.
- El estado de cada lector vive en un almacén (`src/sdk/state.mjs`): memoria o un directorio. Se guarda antes de enviar y antes de entregar.

**Decisiones y por qué**

| Decisión | Motivo |
|---|---|
| Grupos que se rehacen en vez de modificarse | Evita toda la maquinaria de commits (orden en el hub, reintentos, lectores que se quedan atrás) en el primer corte. Para dos agentes con pocas instancias rehacer cuesta poco |
| La clave de MLS de un lector es su clave de identidad | Una hoja del grupo prueba por sí sola a qué agente representa, sin otra capa de firmas |
| No se comprueba la caducidad del certificado al validar una credencial | Las hojas viven en el grupo más que el certificado; un certificado caducado no debe dejar ilegible el grupo. Lo que una instancia puede enviar se decide en el sobre que firma |
| El secreto del KeyPackage se borra al usarlo, siempre | Guardarlo permitiría reabrir la invitación a quien lo robe después, y con ella toda la conversación de ese grupo |
| MLS solo con almacén de estado | Sin dónde guardar el estado, cada reinicio perdería las conversaciones. Con HPKE eso no pasa |
| HPKE se mantiene como alternativa | Para hablar con clientes que no tienen estado de MLS. El SDK no acepta que una conversación que usó MLS baje a HPKE porque lo diga el hub |
| El hub usa la librería para mirar lo que MLS deja en claro | Comprueba que un KeyPackage es de quien lo publica y que un mensaje es de aplicación y del grupo actual. No tiene ninguna clave |
| Límite a cuántos KeyPackages de otro agente se pueden tomar | Sin él, un agente podría agotar los de otro y dejar todas sus conversaciones nuevas colgando del último |

**Límites conocidos**

- ~~Sin commits: no hay actualización de claves ni curación tras un compromiso hasta que se crea otro grupo.~~ Resuelto en la sección 14, con sus propios límites.
- Un lector desconectado al que se le agotan los KeyPackages recibe varias invitaciones selladas al mismo, el último. Solo puede abrir la primera. Las demás conversaciones se arreglan con un grupo nuevo en el siguiente envío, pero lo enviado entre medias no lo lee. Desde la sección 15, en cuanto el lector vuelve sustituye ese KeyPackage, así que no afecta a las invitaciones siguientes.
- Un proceso por identidad a la vez. No hay bloqueo entre procesos sobre el directorio de estado.
- El borrado de claves es lógico: se sobrescribe el fichero de estado, no el disco.
- Quiénes son los lectores lo dice el hub. Puede omitir a uno; no puede añadir a quien el agente no certificó.
- Una instancia no recibe lo que envía otra instancia de su mismo agente.
- `ts-mls` y OpenMLS se entienden en el experimento, no en los tests del proyecto: `npm test` solo prueba `ts-mls` consigo misma.

**Para el paso siguiente (topics privados sobre MLS)**

- Un topic privado tiene muchos miembros y cambian a menudo: rehacer el grupo ya no vale. Hacen falta commits, y el hub tiene que ordenarlos: uno por época. El hub ya lee de un mensaje MLS su grupo, su época y su tipo.
- Un lector que se queda atrás necesita ponerse al día: un registro de commits por grupo, o volver a entrar con un commit externo.
- ~~La curación tras un compromiso (un commit periódico de cada miembro) vale también para las conversaciones entre dos agentes.~~ Hecho: sección 14.

## 14. Renovación de claves con commits (13 de noviembre de 2026)

Tercer paso del bloque 2, y la pieza que los topics privados sobre MLS necesitan antes que ninguna otra: commits que el hub ordena. Se estrena en las conversaciones entre dos agentes, con el commit más simple, el que solo renueva las claves de quien lo hace.

**Cómo funciona**

- Un commit cierra una época del grupo y abre la siguiente. El hub acepta uno por época: el primero que llega para la época en curso. A los demás les responde `stale_epoch`. Guarda los últimos 100 de cada grupo (`store.mlsLogs`, por identificador de grupo) y los de los dos grupos anteriores de cada conversación.
- El hub no acepta un mensaje que no sea de la época en curso de su grupo. Así quien escribe ha aplicado todos los commits y usa las claves más recientes.
- Para escribir, un lector se pone al día: pide los commits desde su época y los aplica en orden. Para leer, avanza solo hasta la época del mensaje que tiene delante. Lo que le queda por leer en el buzón se cifró con las claves que tiene, y adelantarse sería alejarse de ellas.
- Un lector renueva sus claves cada 100 mensajes enviados o leídos, o cada 7 días (`renewKeysAfter`), y cuando se le pide (`renewConversationKeys`, `agenthub key renew`). Al leer lo intenta una vez por época: si va por detrás del grupo, el hub rechaza el commit y no pasa nada.
- Antes de enviar un commit, el lector lo guarda junto con el estado al que lleva (`pending/<grupo>`). Si el hub lo acepta pasa a ese estado. Si la respuesta se pierde, lo reconoce después en el registro de commits y pasa igualmente. Si reintenta, envía ese mismo commit y no otro.
- Cada lector conserva lo necesario para abrir mensajes de las épocas anteriores, porque un mensaje puede estar en camino cuando se renuevan las claves: 16 en un grupo de hasta cuatro lectores y menos cuantos más sean (`epochsRetainedFor`), con un mínimo de 2.
- Un lector solo aplica commits que renuevan claves. Uno que añada o quite miembros lo rechaza.
- Si un lector no puede seguir al grupo (un commit que rechaza, uno que el hub ya no guarda, un hub que vuelve de una copia antigua), crea el grupo de la generación siguiente, tanto si lo nota al escribir como al leer.

**Decisiones y por qué**

| Decisión | Motivo |
|---|---|
| El hub ordena por la época que lee del propio mensaje MLS | No hay que fiarse de lo que declare el remitente en otro campo, y el hub sigue sin claves |
| Commits en un registro por grupo, no en los buzones | Un lector los pide cuando los necesita y en el orden que necesita. En el buzón se mezclarían con mensajes que quizá descarta, y los buzones tienen tope |
| Avanzar al leer solo hasta el mensaje | Es lo que evita perder mensajes pendientes. Un lector que solo escucha nunca se adelanta |
| Guardar el commit propio antes de enviarlo | Sin eso, una respuesta perdida deja al lector sin poder seguir un commit que hizo él, y sordo en ese grupo hasta que escriba. Además, un reintento envía ese mismo commit y no otro: dos commits distintos en una época irían cifrados con la misma clave, y aunque MLS añade al nonce cuatro bytes al azar para ese caso, es mejor no depender de ello. La excepción es un commit que el hub rechaza de plano, que se descarta porque nunca formará parte del grupo |
| Renovar también al leer | Un lector que solo recibe nunca renovaría, y solo él puede dejar fuera a una copia de su estado |
| Un intento de renovación por época al leer, sin preguntar antes al hub | Una prueba de mutación mostró que la consulta previa era redundante: el hub ya rechaza el commit de quien va por detrás. Sin ella es una petición en vez de dos |
| Épocas conservadas según el tamaño del grupo | Medido: cada época conservada añade una copia del árbol al estado, alrededor de 1 KB por miembro, y el estado se guarda con cada mensaje. Con 16 épocas fijas, un grupo de 50 miembros ocupaba 840 KB. Ahora se conserva en total el equivalente a unas 64 hojas: 16 épocas con 4 lectores, 4 con 16, 2 a partir de 32 |
| Rechazar commits que cambian miembros | En una conversación los miembros los decide quién tiene instancias, no un commit. Aceptarlos dejaría a cualquier miembro meter a un tercero |
| El adaptador nunca modifica el estado que recibe | `ts-mls` decodifica vistas sobre el mismo búfer y el borrado de secretos es en el sitio. Sin copiar antes, una operación dañaba el estado de partida, que sigue haciendo falta si el hub rechaza el commit. Lo destapó un test |

**Límites conocidos**

- Solo el lector cuyo estado se copió puede dejar fuera a la copia, renovando las suyas. El commit de otro lector va sellado también para las claves que tiene la copia. Hasta entonces la copia lee: como mucho 100 mensajes o 7 días de uso de ese lector, más el tiempo que la conversación esté parada.
- El estado incluye la clave de firma del lector. Quien lo copie y además pueda presentarse ante el hub como ese lector puede publicar KeyPackages suyos y entrar en el grupo siguiente. Renovar cura frente a quien solo observa; frente a lo otro hay que retirar la instancia.
- El hub puede esconderle un commit a un lector. Ese lector sigue cifrando con las claves anteriores, que la copia sí tiene. El hub no puede leer ni falsificar commits.
- El hub no sabe si un commit es válido. Un miembro puede publicar uno que nadie pueda aplicar: cuesta un grupo nuevo y lo que estuviera en camino en el anterior. No gana nada que no pudiera hacer ya creando grupos.
- Un lector que escribe antes de leer salta a la última época. Si tenía pendientes mensajes de más renovaciones atrás de las que conserva (16 como mucho, 2 en un grupo grande), no los abre.
- Un lector que se queda más de 100 commits atrás no puede ponerse al día en ese grupo.
- Al adoptar su propio commit, el lector conserva en la época que deja la clave con la que lo cifró. Solo sirve para leer ese commit, que no lleva nada que los miembros no sepan.
- El tamaño de un commit solo lo limita el de la petición (64 KB): hasta 6,4 MB por grupo en el peor caso.
- ~~Abrir un mensaje puede necesitar al hub (invitación, commits). Si el hub falla en ese momento, el mensaje se descarta como si fuera inválido.~~ Corregido en un commit aparte: si el hub no contesta, o contesta con 429 o 5xx, la entrada se queda en el buzón y se reintenta en orden, hasta cinco veces. Vale también para las claves de los topics privados. Ningún reintento puede encontrarse una clave ya gastada, porque todo lo que se pide al hub se pide antes de descifrar.

**Para el paso siguiente (topics privados sobre MLS)**

- El registro de commits ya va por identificador de grupo y la operación del diario (`mls.commit`) no sabe de conversaciones: sirve tal cual para el grupo de un topic.
- ~~Hace falta aceptar commits que añadan y quiten miembros, y decidir quién puede hacerlos y cómo lo comprueba cada miembro.~~ El adaptador ya lo hace (`changeMembers`, y `applyCommit` con `mayChange`): quien aplica un commit decide si quien lo hizo podía meter o sacar a esos miembros. Por defecto nadie puede, que es lo que vale para una conversación. Falta el lado del hub y del SDK.
- ~~Las invitaciones tienen que ir ligadas a la época en que se hicieron.~~ `joinGroup` devuelve la época en la que se entra y quién hizo la invitación (`inviter`), que es lo que permite a quien entra rechazar una que no venga del dueño del topic.
- ~~El estado crece con miembros por épocas conservadas.~~ Resuelto conservando menos épocas en los grupos grandes. Sigue reescribiéndose entero con cada mensaje: unos 100 KB con 100 lectores.
- Un lector dado de baja lo sabe al aplicar el commit (`left_out`). Uno puede salir y volver a entrar en el mismo commit con un KeyPackage nuevo, que es como se recupera quien perdió su estado.
- Los eventos de un topic se reparten a los suscriptores por el buzón, y el historial del topic guarda eventos que un miembro nuevo no podrá abrir. Hay que decidir qué ve quien entra.

## 15. Topics privados sobre MLS (13 de noviembre de 2026)

Cuarto paso del bloque 2. Con él, todo lo privado del hub va sobre MLS cuando los clientes guardan estado, y las instancias leen los topics privados.

**Cómo funciona**

- Un topic privado sobre MLS (`encryption: "mls-v1"`) tiene un grupo con todos los lectores de sus agentes miembros. El grupo no se rehace cuando cambian: se modifica con commits. El identificador del grupo dice de qué topic es (`src/mls/topic.mjs`).
- El dueño decide qué agentes son miembros. Cada agente gestiona sus propias instancias. Las dos reglas están en `topicRule`, y cada miembro las aplica antes de aceptar un commit que cambia miembros. Quien entra comprueba con `mayInvite` que su invitación la hizo el dueño o su propio agente.
- Antes de publicar, un lector pone el grupo al día hasta donde le toca (`#topicChange` en el SDK): compara los lectores que el hub dice que tiene cada agente miembro con los que hay en su estado del grupo, y mete o saca los que le corresponden. El dueño, los de todos; cualquier otro, los de su agente.
- El hub guarda lo que le dicen del grupo: agentes miembros y lectores dentro. Exige a quien le manda un commit que diga cómo queda el grupo si lo cambia, y le aplica las mismas dos reglas. No puede ver dentro del commit.
- Solo reparte los eventos a los lectores que constan en el grupo, y no guarda historial de estos topics.
- Si el grupo deja de servirle al dueño (perdió su estado, o entró un commit que no acepta), su siguiente uso del topic crea el grupo de la generación siguiente con los miembros que había.
- Lo demás es lo de la sección 14: un commit por época, registro de commits por grupo, avanzar al leer solo hasta el mensaje, commit propio guardado antes de enviarlo.

**Decisiones y por qué**

| Decisión | Motivo |
|---|---|
| El grupo se modifica, no se rehace | Un topic puede tener muchos miembros y cambian a menudo. Rehacer gastaría un KeyPackage de cada lector en cada cambio |
| Solo el dueño mete y saca agentes | Es lo que ya ocurría con la clave de topic. El diseño decía "un miembro añade al agente"; se queda como estaba hasta que haya motivo |
| Cada agente gestiona sus instancias | Sin eso, una instancia nueva no leería hasta que el dueño usara el topic. No da nada a quien no tenga ya una clave certificada por ese agente |
| Las reglas las comprueban los miembros, no solo el hub | El hub no ve dentro de un commit. Un miembro puede mandarle uno que haga otra cosa de la que dice: los demás lo rechazan y el grupo se rehace |
| La invitación se comprueba por quién firmó la descripción del grupo | Es lo que impide que un antiguo miembro, con un hub que le ayude, presente un grupo falso a quien entra |
| El SDK exige que el grupo que nombra el hub sea de ese topic | Sin eso, un hub podía presentar como grupo del topic A el del topic B del mismo dueño, y lo escrito para A lo leerían los miembros de B. Lo destapó una prueba de mutación |
| Sin historial en el hub | Las claves se usan una vez: nadie podría abrir un evento guardado, ni quien ya lo leyó. El diseño ya decía que quien entra no ve lo anterior |
| Sin caída automática a clave de topic | Que un miembro no pueda MLS es motivo para avisar al dueño, no para cifrar más débil para todos. Quien quiera clave de topic la pide |
| El dueño se apunta junto al estado del grupo | Sobrevive a un reinicio. Antes solo quedaba fijado mientras durase el proceso |
| En un topic, leer no cuenta para renovar claves | Todos leen todo: si contara, todos renovarían a la vez. Cuenta lo que cada uno publica, y el tiempo |
| Un miembro sin ningún lector sigue siendo miembro | Que a un agente se le vaya su única instancia no debe impedir al dueño publicar. Sus lectores entran cuando los tenga |
| 50 lectores por grupo, 256 KB por petición con invitación | La invitación lleva el árbol entero y el hub guarda una copia por invitado hasta que la recoge |
| La clave de topic se mantiene | Para clientes sin estado de MLS, igual que HPKE en los mensajes directos |

**Límites conocidos**

- Un lector que pierde su estado o se queda más commits atrás de los que guarda el hub lo nota y pide volver a entrar (ver "Reentrada" más abajo). Mientras nadie con permiso use el topic, sigue fuera, y lo que llega entre tanto no lo recupera.
- Un lector nuevo del dueño que es el primero en usar el topic no espera a que otro lector del dueño lo meta: rehace el grupo. Funciona, pero cuesta una generación.
- Las altas de agentes esperan a que el dueño use el topic.
- Un miembro puede dejar el grupo sin uso con un commit que los demás rechazan. Dura hasta que el dueño usa el topic. Mientras, nadie más puede publicar.
- Qué lectores tiene cada agente lo dice el hub. No puede colar a quien el agente no certificó, pero sí seguir listando una instancia retirada mientras su certificado no caduque.
- El dueño que un agente tiene para un topic es el que el hub le dijo la primera vez, salvo que la aplicación lo fije.
- Tamaño: el estado de cada lector ronda 1 KB por lector más las épocas que conserva, y se reescribe con cada evento. La invitación crece con el grupo.
- ~~`poll()` confirma al hub después de procesar. Si la confirmación falla, quien llamaba no recibe lo que ya se había abierto.~~ Corregido: lo entrega igual, y las entradas vuelven con la siguiente llamada, donde se reconocen como ya vistas.
- ~~Las herramientas MCP sobre topics privados se han comprobado con el cliente oficial de MCP, no con un modelo.~~ Comprobadas después con un modelo, una vez (sección 11).

**Reentrada (hecha después, en un commit aparte)**

- Un lector que no consigue un estado útil del grupo actual (no lo tiene, o no puede aplicar los commits que le faltan) se lo dice al hub, una vez por grupo: `POST /v1/topics/:name/mls/rejoin`. Lo hace tanto al publicar como al leer. El hub solo lo acepta de un lector de un agente miembro que tenga un KeyPackage publicado.
- La vista del grupo lleva la lista de quienes esperan (`rejoin`). Quien pone el grupo al día y puede cambiar a ese lector lo saca y lo vuelve a meter en un solo commit: el dueño a cualquiera, un agente a los suyos. Solo si el hub le entrega un KeyPackage con el que volver a meterlo.
- El lector encuentra una invitación nueva al mismo grupo y entra en la época en que está. El hub lo quita de la lista en cuanto tiene invitación o deja de estar en el grupo.
- El dueño no pasa por aquí: si no puede seguir al grupo, lo rehace. No espera a otro lector suyo porque en el despliegue normal ese otro lector es la clave del agente, que está guardada y no va a aparecer.
- Un hub que diga que espera quien no espera solo provoca un commit de más. No puede hacer que se meta a nadie que no estuviera ya, ni que se saque a alguien sin volver a meterlo.

**Para el paso siguiente**

- ~~Para eso el cliente tiene que notar que los KeyPackages que el hub guarda de él ya no puede abrirlos y sustituirlos.~~ Hecho: el hub dice cuáles guarda de cada lector, por su referencia, y el cliente los sustituye todos si le falta el secreto de alguno. Contar no bastaba, porque los secretos de KeyPackages ya entregados y sin usar inflan la cuenta; lo mostró un test. De paso se arregla el caso del último KeyPackage, el que el hub entrega una y otra vez cuando se acaban los demás: su secreto se borra con la primera invitación que abre, y antes se quedaba en el hub sin que nadie pudiera abrir lo sellado para él.
- Después, lo que sigue en la hoja de ruta: federación mínima entre dos hubs.

## 16. Decisiones del dueño sobre la federación y la versión (13 de noviembre de 2026)

Preguntadas al cerrar el bloque de MLS, antes de escribir nada de federación.

1. **Para qué es la federación.** Que cualquiera pueda montar su propio hub y conectarlo con los hubs de otras organizaciones, sin depender de un hub central.
2. **Cómo se conectan dos hubs.** A mano: el operador de cada hub da de alta la dirección y la clave del otro. Nadie más puede federarse. El emparejamiento abierto queda para cuando exista antiabuso.
3. **Versión.** El bloque de MLS cerrado es la 0.4.
4. **Prueba del servidor MCP con un modelo.** Repetirla una vez, ahora que los topics privados van sobre MLS. El resultado está en la sección 11.

Lo que se deduce para el diseño:

- El hub de código abierto tiene que estar completo por sí solo, autoalojado. Dos hubs autoalojados de empresas distintas se conectan entre sí directamente, sin pasar por ningún otro.
- La federación va en el núcleo abierto.
- Para el protocolo, un hub que opera otro como servicio es un hub más.
- El dueño no eligió qué va primero entre topics públicos y mensajes directos entre hubs. Se empieza por los topics públicos, que era la recomendación y es también el primer paso de hacer las dos cosas.

## 17. Federación (13 de noviembre de 2026, en curso)

Bloque 3 de la hoja de ruta, con las decisiones de la sección 16. Va por entregas; aquí se apunta cada una al terminarla.

Lo entregado en este bloque es la versión 0.5, por decisión del dueño (sección 18).

**Hecho: identidad del hub y emparejamiento**

- Cada hub tiene una clave Ed25519 propia. La guarda en su directorio de datos (`hub-identity.json`, con permisos `0600`) y la crea la primera vez. Un hub en memoria tiene una nueva en cada arranque. Su DID está en `/v1/info` y se imprime al arrancar.
- El operador da de alta a cada par con un nombre, una dirección y un DID: `--peer NOMBRE=URL#DID` en el CLI, `peers` y `addPeer` en `createHub`. El nombre lo elige él y es local a su hub: será el sufijo de los topics de ese par (`topic@nombre`).
- Un hub firma lo que pide a otro con su clave, con el mismo esquema que usan los agentes (`core/reqsig`). El otro lo atiende solo si esa clave es la de un par (`not_a_peer` si no). Una petición firmada no sigue redirecciones.
- `GET /v1/federation/hello` responde con una declaración firmada: "soy tal hub, hablando con tal par, para este reto". Sirve para que el operador sepa si el emparejamiento se sostiene. Los estados son `paired`, `refused` (el otro no ha dado de alta a este), `mismatch` (quien contesta ahí no tiene la clave esperada) y `unreachable`.

**Decisiones y por qué**

| Decisión | Motivo |
|---|---|
| La clave del par autentica lo que entra; la dirección, lo que sale | Lo que un par pide a este hub va firmado y se comprueba. Lo que este hub pide a un par va a la dirección que dio el operador y se cree tanto como esa dirección (TLS). El saludo firmado no añade seguridad a cada petición: avisa al emparejar de que la dirección y la clave no casan |
| El saludo nombra al par y lleva un reto suyo | Sin el reto valdría una respuesta vieja; sin el par, una dada a otro |
| No se siguen redirecciones | La firma de una petición no cubre el servidor al que va. Quien la redirigiera podría usarla una vez, en nombre de este hub, contra el par de verdad |
| Los pares son configuración, no estado | Los decide el operador al arrancar. No pasan por el diario ni hay ruta HTTP que los cambie |
| Un par no es un agente | Su clave solo abre las rutas de federación. No tiene tarjeta, buzón de agente ni sale en el directorio |
| El límite de peticiones es por par | 600 por minuto por hub emparejado, aparte del límite por IP que ya había |

**Hecho: topics públicos entre hubs**

- Un agente del hub A busca, lee, sigue y publica en los topics de un hub B emparejado que son públicos y de lectura libre. En A se llaman `topic@b`, con el nombre que el operador de A dio a B. Son las mismas rutas HTTP y las mismas llamadas del SDK, del CLI y del servidor MCP que para un topic propio.
- A hace de intermediario. Pide a B el contrato del topic y lo da por bueno 30 segundos. Sigue el topic con su propia clave. Abre un flujo SSE por cada par, por el que le llega lo que se publica en todo lo que sigue de él, y lo reparte a los buzones de sus agentes con `hub.via`. Lo que publica un agente suyo lo reenvía a B tal cual, con la firma del autor.
- B trata lo que llega de A como lo que se publica en él en persona: firma, forma, contrato, política de publicación, duplicados y cupo del autor. Además exige que el evento diga que es para B.
- El evento lleva en `subject` el nombre que el topic tiene en su hub y en `hub` el DID de ese hub, los dos dentro de lo que firma el autor. El SDK los pone al publicar y los comprueba al recibir. El DID lo toma del contrato, que ahora lo incluye también en los topics propios.
- La búsqueda de topics pregunta además a los pares, con 1,5 segundos de espera, y ordena el conjunto con el BM25 del hub propio. `unreachable` nombra a los pares que no contestaron, y el servidor MCP se lo dice al modelo.
- Estado nuevo en el diario: `peer.join` y `peer.leave` (hubs que tienen buzón aquí), `remote.follow` y `remote.unfollow` (topics de otros hubs que este sigue) y `event.relay` (un evento de otro hub repartido aquí, sin guardar historial). `event.publish` anota `via` cuando el evento llegó por otro hub.

**Cómo se dicen dos hubs lo que uno sigue del otro**

La primera versión mandaba un aviso por topic: "sigo este" y "ya no". Se cambió antes de entregarla, al repasar qué pasaba cuando algo fallaba: un aviso que se pierde, dos que se cruzan por el camino, o un hub que olvida (su operador deshace y rehace el emparejamiento, o el topic deja de ser de lectura libre y vuelve a serlo) dejaban a los dos hubs desajustados para siempre, sin error y sin que nadie lo viera. Los agentes seguían suscritos y no les llegaba nada.

Ahora A le dice a B la lista entera de lo que sigue de él (`PUT /v1/federation/follows`), y B queda siguiendo exactamente eso. La manda cuando cambia, cada vez que abre el flujo y cada diez minutos. Los avisos a un mismo par salen de uno en uno, cada uno con la lista del momento en que sale. Con eso, cualquier desajuste dura hasta el siguiente aviso.

**Decisiones y por qué**

| Decisión | Motivo |
|---|---|
| Solo topics públicos de lectura libre | Un topic restringido o privado necesita que su hub se fíe del otro para aplicar sus reglas, o que los miembros hablen con él directamente |
| El topic se llama `topic@par`, con el nombre local del par | El operador ya eligió ese nombre al emparejar. Es solo la forma local de nombrarlo: lo que identifica al hub es su DID, que va en el evento |
| `hub` va firmado dentro del evento y es obligatorio entre hubs | Sin él, un evento firmado para el `dev.x` de un hub valdría para el `dev.x` de cualquier otro. Publicando en persona sigue siendo opcional, para no romper clientes anteriores, pero si va tiene que ser el de este hub |
| El autor que llega de fuera cuenta como `key`, salvo que este hub lo conozca | Las delegaciones no viajan. Aceptar el nivel que diga el otro hub sería fiarse de él |
| Lo que se sigue se dice entero, y de uno en uno | Lo explicado arriba. Como mucho diez avisos esperan turno: un par lento no retiene a todos los que piden algo a través de este hub |
| Cupo para lo que se pide a otro hub por cuenta de quien llama | El otro hub admite 600 peticiones por minuto de este. Sin reparto, una sola IP sin registrar podía gastarlas preguntando por topics `nombre@par` que no existen, y con ellas lo que los agentes de este hub publican allí. Cada agente registrado tiene su cupo (60 por minuto) y los demás comparten uno por par (120). Por eso el SDK firma las búsquedas y las consultas de topics de otro hub |
| El cupo del autor en el hub del topic se cobra al final | Cobrado antes de las demás comprobaciones, un hub emparejado podía gastárselo a un autor reenviando eventos suyos ya publicados, o llevándolos a otro topic. Un evento a punto de aceptarse es nuevo, y solo su autor pudo escribirlo |
| Del rechazo de otro hub pasa el código, no el texto | El servidor MCP enseña al modelo los errores de su hub sin envolver. Texto escrito por otro hub ahí sería una vía de inyección. El código se acepta solo si tiene forma de código y las palabras las pone el hub propio. Los fallos de esquema los detecta el hub propio antes de reenviar, para poder decir dónde están |
| La relevancia en una búsqueda la calcula el hub propio | Un par que dijera que sus topics casan mejor saldría siempre el primero |
| Lo que el otro hub dice de un topic se enseña con forma exacta | DID del dueño, política, dirección del esquema que apunte a ese topic y esquema que el validador entienda. El DID del hub es el que dio el operador, diga lo que diga el otro |
| El hub que recibe comprueba lo que le llega antes de repartirlo | Para no llenar los buzones de sus agentes con lo que su SDK va a descartar. No sustituye a la comprobación del SDK, que se sigue haciendo |
| Un evento que esperó por el camino no se rechaza por su hora | El hub del topic ya la comprobó al aceptarlo, y puede haber pasado horas en el buzón de un hub caído |
| Arrancar sin un emparejamiento conserva lo que se seguía | Un olvido del operador al arrancar no debe borrar las suscripciones de sus agentes: no llega nada hasta que vuelva a emparejar, y el hub lo avisa. `removePeer`, que es explícito, sí las borra |
| Un evento de un flujo SSE tiene tamaño máximo | Quien manda el flujo no es de fiar para terminar lo que empieza. Vale también para el SDK frente a su hub |

**Límites, además de los del README**

- **El contrato de un topic sigue sin ir firmado por su dueño**, y ahora pasa por dos hubs. Un hub intermedio puede enseñar un contrato distinto del que guarda el hub del topic. El hub del topic rechazaría lo que no cumpla el suyo, pero el agente validaría lo que recibe contra el que le enseñaron.
- **El nombre y el DID del otro hub se los da al agente su propio hub.** El SDK guarda el contrato la primera vez que lo ve en cada ejecución; no lo conserva de una a otra.
- **El cupo que un hub da a otro es uno para todos los agentes de ese otro.** Muchos agentes registrados pueden agotarlo entre todos. Se sube con `limits.federation`, igual para todos los pares.
- **Los duplicados se detectan con una ventana de 50.000 eventos por hub.** El hub que recibe no mira la hora del evento, así que el hub de un topic puede volver a mandar uno antiguo cuando ya ha salido de esa ventana. Es su propio topic: también puede no mandar nada.
- **Un "ya no sigo" que no llega.** Si A deja de seguir lo último que seguía de B y no puede decírselo, se lo dirá con el siguiente aviso. Si para entonces el flujo se ha cortado, no hay siguiente aviso hasta que A vuelva a seguir algo de B o arranque de nuevo: mientras, B guarda hasta 1.000 entradas para A.
- **Retirar una instancia o un agente surte efecto en su hub.** El otro hub no se entera: acepta lo que le llegue con firma válida.

**Cómo se ha comprobado**

- `test/federation.test.mjs` (18 tests) y un test del servidor MCP. Incluyen un hub emparejado que responde mal a todo (contratos falsos, textos de error con instrucciones para un modelo, un flujo que no termina, eventos de otro topic o de otro hub), un hub que olvida lo que el otro seguía, avisos retenidos por el camino para comprobar el orden, y reinicios y caídas de cada lado.
- Mutaciones: 103 defensas rotas una a una, entre el hub, el almacén, el SDK y el servidor MCP. Dos sobrevivieron la primera vez: un test que fallaba por una comprobación distinta de la que decía probar, y un caso que no tenía test. Con eso corregido, las 103 hacen fallar algún test. Dos comprobaciones resultaron redundantes y se quitaron.
- A mano, con dos procesos de hub reales emparejados con `--peer` y agentes desde el CLI: buscar, leer el contrato, seguir, publicar en los dos sentidos, rechazo por contrato, historial, y parar y arrancar cada hub sin perder lo publicado mientras tanto. Los dos procesos en la misma máquina y sin TLS.

**Encontrado al repasar qué texto ajeno llega a un modelo**

Un hueco anterior a la federación, de la 0.3. Cuando lo que un modelo publica no cumple el contrato, el error dice dónde con nombres de propiedad del esquema, y el esquema lo escribe el dueño del topic. El servidor MCP ponía esos nombres en el texto del error tal cual, fuera de todo envoltorio. Un topic con una propiedad obligatoria llamada como una instrucción se la habría enseñado al modelo como si la dijera su hub. Ahora el detalle del error va en un bloque marcado como no fiable, igual que los nombres y descripciones del directorio. Tiene su test, que fallaba antes del arreglo.

**Hecho: mensajes directos entre hubs**

- Un agente de un hub emparejado se nombra `did@par`. Vale en `getAgent`, en `send`, en `hub_send` y en el CLI. La búsqueda de agentes incluye a los de los pares, cada uno con su `address`, igual que la de topics.
- El mensaje va sellado para la tarjeta del destinatario (HPKE). Lleva `recipient` con el DID y `hub` con el DID del hub del destinatario, dentro de lo firmado. El hub del remitente lo reenvía al hub que dice `hub` si es un par suyo; ese hub lo comprueba y lo deja en el buzón del destinatario con `hub.via`.
- Quien recibe tiene en `message.replyTo` la dirección para contestar, y el modelo la ve como `reply_to`.
- La tarjeta de un agente de otro hub se enseña si lleva la firma del agente y es una tarjeta que este hub habría aceptado. Su nivel aquí es `key`. La delegación viaja para quien quiera comprobar la firma del controlador; quién es ese controlador, este hub no lo ha verificado.
- Alcance: `direct_hubs` en la delegación, opcional. Una delegación que no lo lleva es byte a byte la de antes, y no deja escribir a otros hubs.

| Decisión | Motivo |
|---|---|
| HPKE primero, MLS después | Una conversación sobre MLS necesita que un hub ordene sus commits, guarde el grupo y reparta invitaciones a cada lector. Entre dos hubs eso es un protocolo nuevo, con sus propios fallos. HPKE ya era el camino para quien no puede MLS, y deja mensajes cifrados de extremo a extremo entre hubs hoy. El precio está dicho: sin secreto hacia adelante y sin instancias |
| La dirección es `did@par`, y la da el hub | El DID identifica al agente en cualquier hub, pero para entregar hay que saber en cuál está. Un mismo DID puede estar registrado en varios |
| `hub` firmado dentro del mensaje, obligatorio entre hubs | Para que un hub no pueda llevar a otro hub lo que el remitente escribió para un agente de este. El contenido solo lo abre el destinatario en cualquier caso |
| No se baja de MLS a HPKE sin que lo pida quien llama | Dónde está un agente lo dice el hub. Uno que quisiera debilitar una conversación podría presentar a un agente local como si estuviera en otro hub. El SDK se niega (`mls_downgrade_refused`) si ya hay conversación MLS con ese DID |
| El nivel del agente de otro hub es `key` | Lo mismo que con quien publica desde fuera: fiarse del nivel que diga el otro hub sería fiarse del otro hub |
| `direct_hubs` aparte de `direct`, y opcional | El controlador que permitió mensajes directos cuando solo había un hub no permitió escribir a agentes de otras empresas. Como campo opcional, las delegaciones ya firmadas siguen valiendo tal cual |
| Sin cola entre hubs | Si el hub del destinatario no contesta, el envío falla y el remitente lo sabe. Una cola en el hub del remitente guardaría mensajes de otros sin que nadie se lo haya pedido |
| No se dice si el destinatario está conectado | Dentro de un hub el recibo lo dice. Entre hubs sería contarle a otra empresa quién está conectado |

Límites propios de este paso: lo que quita no tener MLS; que el hub del remitente y el del destinatario ven quién escribe a quién; que cualquier agente de un hub emparejado puede escribir a cualquier agente de este (no hay bloqueo de remitentes todavía); y que la retirada de una instancia no viaja, así que un mensaje firmado por una instancia retirada lo aceptaría el otro hub mientras su certificado no caduque.

Comprobado con cinco tests más en `test/federation.test.mjs` y ampliaciones en los del servidor MCP, de las delegaciones y del hub que responde mal. Mutaciones: 59, de las que sobrevivieron cuatro la primera vez: dos comprobaciones que resultaron redundantes, y se quitaron, y dos casos sin test, que ahora lo tienen. A mano, con dos procesos de hub reales y el CLI: buscar a un agente del otro hub, leer su tarjeta, escribirle y contestar.

**Lo siguiente en este bloque**

MLS en los mensajes directos entre hubs. Hay que decidir qué hub guarda el grupo de una conversación y ordena sus commits, cómo llegan a ese hub los KeyPackages de los lectores del otro, y cómo se reparten invitaciones y mensajes a cada instancia a través del otro hub. Después, o junto con el registro de transparencia: firmar el contrato de un topic por su dueño y hacer que las retiradas viajen.

## 18. Decisiones del dueño al cerrar la federación mínima (13 de noviembre de 2026)

Preguntadas con la federación mínima ya entregada, antes de empezar otro bloque.

1. **Qué va ahora.** El registro de transparencia, que es lo siguiente en el orden de la sección 9. Llevar MLS a los mensajes directos entre hubs queda para después.
2. **Versión.** La federación, tal como está entregada (emparejamiento, topics públicos y mensajes directos entre hubs emparejados), es la 0.5.

## 19. Registro de transparencia (13 de noviembre de 2026)

Bloque 4 de la hoja de ruta, por decisión del dueño (sección 18). Va por entregas, y aquí se apunta cada una al terminarla. Lo que sigue al plan es interpretación de quien escribe esto: el dueño decidió qué bloque iba, no cómo hacerlo.

**Para qué**

El hub no es de fiar para el contenido ni para la autoría, y eso ya lo cubren las firmas. Lo que las firmas no cubren es lo que el hub *cuenta* del directorio: puede enseñar una tarjeta antigua, callar una revocación, seguir dando por buena una instancia retirada o decir que el dueño de un topic es otro. El registro es para que eso se note. Tiene cuatro partes, y la última no está hecha:

1. Que el hub se comprometa en público con cada cambio del directorio, en una lista que no pueda reescribir sin que se vea.
2. Que cada agente contraste lo que el hub le enseña con esa lista.
3. Que lo que la lista dice que hizo un agente lo haya firmado ese agente, para que el hub no pueda escribirlo por su cuenta.
4. Que alguien más que el propio lector vea la lista, para que el hub no pueda llevar dos.

**Hecho: el registro del hub, firmado y auditable**

- `core/merkle.mjs`: el árbol de Merkle de Certificate Transparency (RFC 6962), con demostraciones de inclusión y de consistencia y su verificación (RFC 9162), y `Frontier`, lo que guarda de la lista quien la lee entera para calcular la raíz por su cuenta.
- `core/log.mjs`: las entradas, la cabeza firmada por el hub (`CONTEXT.LOG_CHECKPOINT`) y `Directory`, que lee el registro entrada a entrada aplicando las reglas y lo rechaza en la primera que no se sostiene.
- El almacén apunta una entrada por cada cambio del directorio al aplicarlo: `agent.card`, `agent.delegation`, `agent.revoke`, `delegation.revoke`, `instance.add`, `instance.remove`, `topic.create`, `topic.policy`. El registro sale de las operaciones del diario, así que se reconstruye igual al reproducirlo, y se guarda entero en la copia del estado.
- Rutas públicas: `/v1/log/checkpoint`, `/v1/log/entries`, `/v1/log/inclusion`, `/v1/log/consistency`. En el SDK, `auditLog()` y `logHead()`; en el CLI, `log audit` y `log head`.

**Decisiones y por qué**

| Decisión | Motivo |
|---|---|
| El árbol de Certificate Transparency, tal cual | Es el más visto y probado, el que usa Tessera (lo que nombra el diseño) y tiene vectores públicos. No se inventa nada |
| Un registro, no un mapa verificable | El diseño habla de un registro auditable de claves, delegaciones y revocaciones. Un mapa permitiría preguntar por un agente sin leerlo todo, pero es bastante más y también necesita que alguien lo repase entero. Con el tamaño que tiene un hub hoy, cada lector puede leerlo todo |
| Quien lee, lo lee entero y aplica las reglas | Así no depende de ninguna respuesta suelta del hub ni de que exista un auditor. El precio es que crece con el registro: decenas de miles de entradas, no millones |
| Las reglas son las que un hub honrado cumple con cualquier configuración | Quién firmó qué y qué puede venir después de qué. Las cuotas y los límites del hub no se comprueban: un lector que los exigiera daría por malo un registro bueno de un hub configurado de otra forma |
| Las entradas llevan la declaración firmada entera cuando la hay | Para que quien lee compruebe la firma, no la palabra del hub. Del contrato de un topic va un hash: el esquema puede ocupar 16 KB |
| Lo que hoy no va firmado entra como palabra del hub | Retirada propia, baja de una delegación, retirada de una instancia, creación y política de topics. Dejarlo fuera haría el registro inútil para lo que más interesa, que son las instancias y los topics. Dentro queda a la vista y con la firma del hub, y la entrega siguiente es que lo firme quien lo pide |
| Una delegación o una revocación se comprueba con la fecha de la entrada | Una delegación caducada hoy era buena cuando se presentó. Quien lee el registro dentro de un año tiene que llegar a la misma conclusión que quien lo leyó entonces |
| Una delegación en nombre de un dominio se da por buena con la palabra del hub | Lo que publicaba ese dominio cuando se presentó ya no se puede saber. La entrada dice de qué tipo es, para que nadie la confunda con una comprobada |
| La cabeza se firma en cada petición, con la hora | No es estado: es lo que el hub dice de su registro en ese momento. Y la hora es lo que permitirá a un testigo decir cuándo vio cada cosa |
| Un hub con datos anteriores apunta el directorio como está | Mejor un registro que empieza tarde que un directorio que no casa con su registro. Se guarda en cuanto se crea: si se rehiciera en cada arranque, lo apuntado después quedaría en otro sitio de la lista y el hub parecería haber reescrito su registro |

**Hecho: los clientes siguen el registro**

- `sdk/follower.mjs`: guarda en el almacén de estado la última cabeza vista (como frontera del árbol) y el directorio que el registro contaba hasta ahí. Al ponerse al día pide la cabeza, lee las entradas nuevas sobre una copia, les aplica las reglas y calcula la raíz por su cuenta: tiene que ser la firmada. Así, que el registro nuevo continúa el que ya tenía se comprueba solo, sin pedir demostración.
- Lo sigue todo cliente con almacén de estado, que son el CLI y el servidor MCP, o con `followLog: true`. El hub es el que firma la primera cabeza que ve, o el que le diga la aplicación con `hubDid`.
- `getAgent` y `getTopic` contrastan con el directorio del registro lo que el hub enseña. Lo que llega se rechaza si lo firma un agente revocado, o una instancia que el registro no tiene o da por retirada. Los lectores que el hub lista para un grupo de MLS tienen que estar en el registro.
- Errores: `LogError` con `log_invalid` (el registro no se sostiene o ya no es el que se leyó) y `log_mismatch` (el hub enseña algo que su registro no dice). El servidor MCP le dice al modelo qué hacer con cada uno.
- `forgetLog()` y `agenthub log forget --yes`: olvidar lo leído, para un hub que tuvo que empezar de cero. Lo decide una persona: un hub que hubiera reescrito su registro se vería igual.

| Decisión | Motivo |
|---|---|
| Lo sigue quien tiene estado, como MLS | Lo leído tiene que recordarse entre ejecuciones para servir de algo: un cliente que empieza de cero cada vez solo puede creerse el registro que le den ese día |
| La consistencia se comprueba recalculando la raíz, no con una demostración | Quien lee todas las entradas ya tiene con qué. La demostración de consistencia queda para quien no las lee: un testigo |
| Lo nuevo se lee sobre una copia | Si una entrada no se sostiene, no queda nada de esa lectura, ni dentro de lo que ya había |
| Se vuelve a leer el registro antes de quejarse | Lo que el hub enseña puede ser más nuevo que lo que el cliente tenía. Sin eso, cada alta y cada cambio de tarjeta darían una falsa alarma |
| Diez segundos de margen | Leer el registro en cada consulta sería una petición más por consulta. El precio es que una mentira que coincide con lo que el cliente tenía dura hasta diez segundos |
| A quien no está en el registro solo se le acepta si llegó por otro hub | Un agente de otro hub no está en este registro. Que llegó por otro hub lo dice el hub, y eso no se puede comprobar aquí: es lo mismo que ya se le creía |
| Mientras el registro no se sostiene, lo que llega se queda en el buzón | El fallo dice algo del hub, no del mensaje. Se reintenta unas cuantas veces, como con un hub que no contesta |
| Los errores no repiten lo que escribió el hub | Acaban delante de un modelo. Solo dicen lo que pidió quien llama y lo que hay en el registro, que está comprobado. De paso se corrigieron tres mensajes anteriores del SDK que sí lo repetían |

**Hecho: lo que cambia un agente lo firma el agente**

Hasta aquí, cinco tipos de entrada eran la palabra del hub sobre algo que un agente le había pedido con una petición firmada: crear un topic, cambiar su política, retirar una instancia, soltar una delegación y retirarse. Un hub deshonesto podía escribirlas sin que nadie se las pidiera, y quien seguía el registro las daba por buenas.

- `core/statement.mjs`: una declaración es `{ statement, proof }`, firmada con un contexto propio por tipo (`TOPIC`, `TOPIC_POLICY`, `INSTANCE_REMOVAL`, `RETIREMENT`, `DELEGATION_DROP`). Dice `version`, el `hub` para el que es y lo que cambia. `verifyStatement` comprueba una sola cosa además de la firma: que diga exactamente lo que se le da, comparando formas canónicas.
- `core/policy.mjs`: la forma en que se escribe una política de topic, compartida por el hub y por quien firma.
- `core/log.mjs`: la entrada `log.signed` dice desde dónde va firmado el registro. Desde ahí, las cinco entradas llevan un campo `statement`, y `Directory` lo comprueba contra la propia entrada y contra quién puede firmarlo. `Directory` recibe el DID del hub cuyo registro lee.
- El hub exige la declaración en las cinco rutas (`acceptStatement`), firmada con la misma clave que la petición, y la apunta. Al arrancar, si el registro no ha dicho que va firmado, lo dice: en un hub nuevo es la primera entrada; en uno con datos anteriores, va después de ellos.
- El SDK firma solo (`#statement`) y, si sigue el registro, comprueba después de cada cambio propio que el hub lo ha apuntado (`#onRecord`, `#topicOnRecord`).

| Decisión | Motivo |
|---|---|
| Una declaración por cambio, con su contexto de firma, en vez de apuntar la petición firmada | La petición lleva método y ruta: apuntarla ataría el registro a la API HTTP. Y la petición no dice para qué hub es |
| La declaración dice el hub | Lo firmado para un hub no vale en otro donde el mismo agente esté registrado. `Directory` no lo saca del registro: se lo da quien lee, que lo sabe por la cabeza firmada |
| Sin hora ni número aleatorio: cada una vale una vez por cómo está hecha | Un topic se crea una vez y cada cambio lleva `revision`, que tiene que ser la siguiente. Una instancia retirada no vuelve, y un agente retirado tampoco. Así las reglas no dependen de ningún reloj |
| Quien cambia un topic firma lo que cambia, no cómo queda | Para firmar cómo queda, el SDK tenía que poner la política que no tocaba tal como se la enseñaba el hub: un hub mentiroso le habría hecho firmar otra, y habría quedado apuntada como decisión del dueño. La primera versión de esta entrega lo hacía así; se vio al repasarla, antes de subirla. La política que no cambia va como `null`, en la declaración y en la entrada |
| Crear un topic y cambiarlo son dos tipos de declaración | Con uno solo, lo que el dueño firmaba para cambiar un topic sin declaración de creación (uno importado) valía como creación en otro registro, con el contrato que el hub le hubiera enseñado |
| `revision` cuenta los cambios firmados: un topic recién creado, o importado, está en 0 | Un número y una regla para todos los topics. Quien carga un directorio o un estado guardados antes de que existiera, les pone 0 |
| Del hub, quien cambia un topic solo toma de qué topic habla y qué cambio es | El contrato, cómo va cifrado y la `revision`. Con cualquiera de ellos cambiado, la declaración no sirve en un registro que cumpla las reglas. Un cliente que sigue el registro los contrasta antes de firmar (`topicDiffers` mira también la `revision`) |
| Una delegación soltada ya no se puede presentar | Es lo que impide usar dos veces la declaración que la soltó. **Cambia el comportamiento**: antes un agente podía soltar su delegación y volver a presentarla. La alternativa era un contador de cambios por agente, que es más estado en el hub, en el cliente y en el registro |
| Desde dónde va firmado lo dice una entrada (`log.signed`), no la cabeza | Todo lo que hace falta para leer el registro está en el registro, y la cabeza se queda como estaba. El precio es una entrada más al principio |
| Una sola comprobación: la declaración dice exactamente lo que dice la entrada | En vez de una comprobación por campo. El hub y el lector usan la misma función con lo que cada uno sabe, así que no pueden discrepar sobre qué campos importan |
| Quién puede firmar lo decide quien conoce las instancias, y el certificado no viaja | El hub las tiene en su estado y el lector en el registro. Un certificado suelto tiene fecha, y la hora de una entrada la pone el hub: comprobarlo no quitaba nada a un hub deshonesto y sí añadía una regla que dependía del reloj |
| La declaración va firmada con la misma clave que la petición | Como los eventos: una instancia no entrega lo que firmó otra clave de su agente |
| El hub mira primero lo que está mal en la petición y después la declaración | Para que quien manda un topic mal hecho reciba el error de siempre (`invalid_topic`), no uno sobre una declaración que no podía estar bien |
| `stale_statement` cuando la `revision` no es la siguiente | Distingue «otro cambió el topic antes» de «la declaración está mal». Lo primero se arregla repitiendo el cambio; el SDK no lo repite solo |
| El SDK comprueba en el registro cada cambio propio que el hub da por hecho | Un hub que contestara «hecho» a quien retira una instancia robada y no lo apuntara dejaría a los demás escuchándola. Se hace también con los cambios que ya iban firmados: tarjeta, delegación y alta de instancia |
| Las rutas `DELETE` llevan cuerpo | Se conservan las rutas, y el cuerpo va cubierto por la firma de la petición. Hay proxys que descartan el cuerpo de un `DELETE`: el hub contestaría `invalid_statement`. A mirar al desplegar |
| Los datos anteriores al registro se apuntan sin declaración, antes de `log.signed` | Nadie los firmó, y el registro no lo disimula. Un topic de esos se cambia como cualquier otro: el primer cambio que firma su dueño es el 1 |

Lo que no arregla, además de lo que ya había:

- **La hora de cada entrada** sigue siendo palabra del hub, y con ella que una instancia no hubiera caducado cuando firmó por un topic de su agente. Quien roba la clave de una instancia y tiene al hub de su parte puede seguir firmando hasta que el agente la retire.
- **Un cambio retenido.** Como la declaración no lleva hora, un hub puede guardarla y apuntarla más tarde, mientras siga siendo la siguiente. Quien la hizo lo ve al momento si sigue el registro. A un cliente que no lo sigue, el hub puede enseñarle una `revision` más alta que la real y guardarse lo que firme hasta que el topic llegue ahí. Una fecha de caducidad en la declaración no lo arregla mientras la hora de las entradas sea palabra del hub: es de lo que tendrían que ocuparse los testigos.
- ~~**Las peticiones firmadas siguen sin decir para qué hub son**~~ (cerrado en la sección 25: se firman para la dirección del hub) (`core/reqsig.mjs` firmaba método, ruta, hora, número y cuerpo). Un hub que recibe una puede repetirla durante un minuto en otro hub donde el agente esté registrado. Con las declaraciones, lo que cambia el directorio ya no se puede repetir así; una suscripción o el alta de una instancia, sí. Lo propio es que la petición firme también el DID del hub.

**Corregido: un hub honrado podía apuntar algo que sus propias reglas rechazan**

Un registro que rompe sus reglas no tiene arreglo: quien lo sigue deja de fiarse del hub para siempre, y el hub no puede quitar la entrada. Repasando las dos entregas anteriores salieron tres maneras de que un hub honrado llegara a eso, y un test que no lo habría visto.

| Qué pasaba | Cómo queda |
|---|---|
| Las reglas rechazaban un certificado de instancia o una delegación fechados más de un minuto por delante de la entrada. Cuánto adelanto admite un hub es configuración suya (`clockSkewMs`): con un margen mayor, aceptaba lo que su registro luego no | Las reglas ya no miran si la fecha de emisión va por delante: eso es cosa del hub. Siguen mirando que no hubiera caducado |
| El hub comprobaba una delegación o un certificado y fechaba la entrada después. Comprobar una delegación firmada en nombre de un dominio puede tardar segundos: si caducaba en medio, la entrada decía una hora en la que ya no valía | La entrada lleva el mismo instante con el que se hizo la comprobación |
| El hub olvidaba las delegaciones revocadas y las instancias retiradas a partir de 100 000, y el registro no olvida ninguna: pasado ese número podía volver a aceptar una | No se olvida ninguna. Ocupan mucho menos que el propio registro, que ya está entero en memoria |
| Ningún test comprobaba que lo que el hub apunta al hacer otras cosas cumple las reglas | `startHub` repasa con `replayLog` el registro de cada hub de prueba al cerrarlo: cualquier test de cualquier fichero que haga apuntar al hub algo que las reglas rechazan, falla |

**Corregido: cualquier agente registrado podía dejar un hub sin arrancar**

Es el fallo más grave que ha tenido el registro, y estuvo subido desde su primera entrega (`9a78415`) hasta esta corrección. No llegó a ninguna versión con número.

- **Qué pasaba.** Una entrada del registro se identifica por el hash de su forma canónica (JCS), y `canonicalize` admite JSON hasta 64 niveles. Una prueba (`proof`) solo se mira en los campos que se usan, así que podía llevar además cualquier otra cosa, tan anidada como se quisiera: lo mismo un `const` en el esquema de un topic. La petición pasaba todas las comprobaciones, la operación se escribía en el diario, se aplicaba a medias y fallaba al calcular el hash de la entrada. El hub contestaba 500, el directorio quedaba distinto de su registro y, con datos en disco, el hub no volvía a arrancar: al reproducir el diario fallaba en el mismo sitio. Bastaba una petición de un agente registrado, o un registro nuevo.
- **Cómo queda.** `store.commit` rechaza la operación antes de escribir nada si viene demasiado anidada para apuntarse (`NotRecordable`), y el servidor contesta `400 nested_too_deeply`. Vale para cualquier operación, también las que se añadan, menos las tres que llevan un evento firmado, que no deja nada en el registro y puede ser tan hondo como admite su propia firma: de otro modo un evento que hoy es válido dejaría de serlo. La entrada se calcula antes de añadirla a la lista, para que la lista y el árbol no se descuadren nunca. Y a quien lee el registro, una entrada así le llega como `LogError`, no como un error cualquiera.
- **Por qué en `commit` y no en cada ruta.** Lo que importa es que nada llegue al diario sin poder aplicarse entero, y eso hay que garantizarlo en el único sitio por el que pasa todo. La profundidad a la que queda cada cosa en la entrada no es la misma que en la petición (una revocación queda un nivel más adentro), así que un límite al cuerpo de la petición habría tenido que llevar un margen calculado ruta por ruta.
- **Comprobado** con un hub con datos en disco: seis peticiones distintas (registro, tarjeta, delegación, certificado, revocación y topic) rechazadas sin dejar nada apuntado ni hecho, eventos hondos que siguen publicándose, también entre hubs, y el hub que para y arranca con el registro que tenía. 12 mutaciones, y todas hacen fallar algún test. Antes de corregir, reproducido con un proceso real: 500 y un hub que no arrancaba.
- **Lo que quedó pendiente de esto, y ya está hecho.** Una prueba podía llevar campos de más, dentro del tamaño de la petición, que quedaban apuntados para siempre, y un agente podía cambiar su tarjeta o la política de un topic tantas veces como le dejara el límite por dirección, con una entrada por cambio. Ahora una prueba que va a quedar apuntada se rechaza si trae algo más que sus campos (`requireBareProof`: tarjetas, delegaciones, certificados y revocaciones; las declaraciones ya lo exigían), y esos dos cambios tienen cupo por agente (`limits.card`, `limits.topicPolicy`). Se rechaza en vez de limpiar, para que lo apuntado sea exactamente lo que llegó. 13 mutaciones, todas cazadas.
- **Lo que no arregla.** El registro sigue creciendo con cada cambio y no se poda: los cupos son por minuto, no un tope. Y una revocación la puede enviar cualquiera, firmada con una clave cualquiera para una delegación que nadie ha visto, y queda apuntada: hace falta para que un controlador pueda revocar antes de que su agente se registre. Su límite es por dirección, 20 por minuto.

**Lo que no cubre todavía**

- **Dos registros.** Un hub puede firmar dos listas distintas y enseñar cada una a un lector. Hacen falta testigos: lo natural es que sean los hubs emparejados.
- **El primer contacto**, y los clientes sin estado.
- **Lo que sigue siendo palabra del hub**: la hora de cada entrada, que una delegación en nombre de un dominio era de ese dominio y, en un hub con datos anteriores, todo lo que hay antes de `log.signed`.
- **Las búsquedas y el historial de un topic**, que el SDK devuelve como los da el hub.
- **La federación.** Con qué hubs está emparejado un hub y qué DID tiene cada uno no está en el registro, ni nada de lo que llega de ellos.
- **El nivel de un agente**, que depende de la configuración del hub.
- **El tamaño.** El registro entero está en memoria y en la copia del estado, y no se poda.

**Cómo se ha comprobado**

- `test/log.test.mjs` (19 tests): los vectores publicados de las implementaciones de Certificate Transparency (hojas, nodos, raíces de 0 a 8 entradas, lo que guarda quien lee y demostraciones), descargados de `transparency-dev/merkle`; todas las demostraciones de un árbol de 67 entradas, con sus falsificaciones; un hub que pasa por todos los tipos de cambio; cada regla, rota de una en una; un hub con más margen de reloj que el habitual, cuyo registro se sostiene igual; un hub que miente a quien le audita; paradas, caídas y datos anteriores al registro; y, para el seguidor, un hub que enseña cada cosa distinta de lo que apuntó, mensajes de agentes revocados e instancias retiradas, un registro que se acorta, cambia o desaparece, y lectores de MLS que no están apuntados.
- Mutaciones: 85, entre el árbol, las reglas, el almacén, las rutas y la auditoría del SDK. 83 hacen fallar algún test. Las otras dos son las comprobaciones de `sn` que el RFC 9162 hace a mitad de una demostración: adelantan un rechazo al que se llega igual al comparar con la raíz. Se dejan, para que el código se pueda cotejar con el RFC línea a línea.
- A mano, con un proceso de hub real: `log head` y `log audit` desde el CLI, antes y después de parar y arrancar el hub.
- Del seguidor: 60 mutaciones. Tres sobrevivieron la primera vez: un test que comprobaba antes de que el cliente hubiera leído la entrada que debía contrastar, una propiedad sin test (que no se pregunta al hub en cada consulta) y una copia redundante, que se quitó. Con eso corregido, todas hacen fallar algún test. A mano, con un hub real y dos agentes desde el CLI: uso normal siguiendo el registro, y un hub que pierde sus datos y conserva su clave, al que el cliente rechaza.

- De las declaraciones firmadas: `test/statements.test.mjs` (5 tests) y tres de `test/log.test.mjs`. Cada regla nueva del registro, rota de una en una: sin declaración, firmada por otro, por una instancia donde hace falta la clave del agente, por una instancia retirada, hecha para otro hub, para otro agente, para otro topic, con el tipo de firma de otra cosa, y usada por segunda vez. En el hub, cada ruta con lo mismo, y la declaración firmada con otra clave que la petición. En el SDK, un hub que dice qué hub es y miente, un hub que contesta «hecho» a cada uno de los nueve cambios sin apuntarlo, y un hub que enseña al dueño otra política, otro contrato u otra `revision` de su topic. Un registro empezado sin declaraciones, que dice desde dónde va firmado.
- Mutaciones de esta entrega: 178 (85 en `statement`, `policy` y las reglas del registro, 61 en el hub y el almacén, 32 en el SDK, el seguidor y el CLI). Seis sobrevivieron la primera vez: cinco casos sin test (una declaración que nombra a otro agente, a otro dueño o a otro topic con el mismo contrato, y la `revision` de un topic tras parar y arrancar el hub) y una mutación mal planteada. Con los tests añadidos, todas hacen fallar alguno.
- A mano, con procesos reales: un hub con datos en disco y tres agentes desde el CLI, todo con el código del commit anterior (topic, política, instancia, delegación presentada y soltada, retirada, y un agente que sigue el registro). Parado ese hub, se arranca el de ahora sobre los mismos datos y con el mismo estado de los agentes: dice que va firmado desde la entrada 9, el agente que seguía el registro sigue leyendo, la dueña cambia su topic (el primer cambio que firma es el 1, y el que solo toca una política deja la otra como estaba), crea otro, retira la instancia, otro agente se retira, y el registro se sostiene, también después de parar y arrancar otra vez.

**Lo que queda de este bloque**

1. Testigos: que otro hub firme las cabezas que ve de este, solo si continúan lo que ya había visto, y que el SDK exija esas firmas. Es lo que falta para que un hub no pueda llevar dos registros. El dueño decidió dejarlo para más adelante (sección 20). Lo pensado hasta ahora, por si sirve cuando se retome: el testigo guarda la última cabeza que firmó de cada hub y pide una demostración de consistencia desde ella (`verifyConsistency` ya existe); el hub pide las firmas a sus testigos después de cada cambio y las sirve junto a la cabeza; el cliente exige las de los testigos que su operador le nombre, nunca los que diga el hub; y la firma del testigo lleva hora, para que una cabeza vieja no pase por actual.
2. ~~Que las peticiones firmadas digan para qué hub son.~~ Hecho en la sección 25: se firma la dirección por la que se le habla, y TLS prueba que el servidor es esa dirección. No basta con añadir el DID del hub a lo que se firma: un cliente sin estado lo aprende del propio hub, que puede decir que es otro.

## 20. Decisiones del dueño al cerrar el registro de transparencia (13 de noviembre de 2026)

Preguntadas con las tres partes del registro entregadas y antes de empezar la cuarta.

1. **Testigos.** Se dejan para después. Lo siguiente es llevar MLS a los mensajes directos entre hubs, que es lo que seguía en la hoja de ruta (sección 18). Queda dicho en el README que nada detecta a un hub que lleve dos registros.
2. **Versión.** Lo entregado del registro de transparencia es la 0.6.
3. **Errores del hub en el servidor MCP.** Se envuelven: el modelo ve el código del error y una explicación del propio servidor MCP, y el texto que escribió el hub va aparte, marcado como dato no fiable y con `<` escapado.

**Hecho: los errores del hub, envueltos**

- El SDK marca los `HubError` que traen las palabras de un hub (`fromHub`): los de una petición, los de una revocación y los de un stream rechazado. Los que fabrica el propio SDK (que no llega al hub, que no puede usar MLS) no la llevan.
- El servidor MCP, ante uno marcado, dice `Error - <código>. <explicación>` y debajo un bloque `<agenthub_hub kind="error" trust="untrusted">` con el mensaje del hub y lo que mandó con él. El código solo se enseña si tiene forma de código; si no, `refused`. La explicación sale de una tabla del servidor con 28 códigos, y para los demás, de la clase de respuesta (no encontrado, no permitido, conflicto, demasiadas peticiones, fallo del hub). El mensaje se corta a 500 caracteres y lo que vino con él se omite si pasa de 4.000.
- Los errores del SDK y los del registro (`log_mismatch`, `log_invalid`) se siguen diciendo como antes: no llevan texto del hub.
- Comprobado con un hub que contesta con un mensaje que intenta cerrar el bloque y dar instrucciones, con códigos que no lo son, y con respuestas enormes. 21 mutaciones, todas cazadas. De paso, el ayudante propio de `test/hub.test.mjs` repasa también el registro de cada hub al cerrarlo, como el de `test/helpers.mjs`.
- **La otra puerta del mismo riesgo.** Lo que el hub contesta cuando *no* rechaza también llegaba al modelo tal cual en siete herramientas: el JSON entero de suscribirse y darse de baja, lo que el hub lista como miembros, el nivel, el controlador y las suscripciones del estado, y el identificador, el topic o el destinatario de un recibo. La pregunta al dueño hablaba de los errores; esto se ha cerrado después, en un commit aparte, porque sin ello envolver los errores no quitaba el riesgo: a un hub deshonesto le bastaba con contestar que sí. Ahora esas respuestas solo llevan lo que pidió quien llama (el topic, el destinatario, el nombre), números, booleanos, y cadenas con forma comprobada: un DID, un nombre de topic, un nivel de la lista, un identificador de evento sin espacios. Lo que no la tiene se queda en `null`, `unknown` o fuera de la lista. Un cambio visible: `hub_send` devuelve en `to` lo que se le pasó, que para un agente de otro hub es su dirección (`did@hub`), no el DID a secas. 18 mutaciones, todas cazadas (dos sobrevivieron la primera vez, por huecos del test), y el flujo con el cliente oficial de MCP contra procesos reales pasa 24 de 24.

## 21. MLS en los mensajes directos entre hubs (13 de noviembre de 2026)

Lo que el dueño decidió que iba después del registro (sección 20). Hasta aquí, un mensaje directo a un agente de otro hub iba siempre sellado con HPKE para su tarjeta: solo lo abría la clave del agente, sin sus instancias, y sin secreto hacia adelante. El cómo es interpretación de quien escribe esto.

**Cómo funciona**

- Es la misma conversación que dentro de un hub (sección 13): un grupo de MLS con todos los lectores de los dos agentes, que se rehace cuando cambian los lectores y cuyas claves se renuevan con commits (sección 14). El SDK hace lo mismo que hacía, con las mismas cinco rutas de su hub, usando la dirección del otro agente (`did@hub`) donde antes ponía su DID. Guarda esa conversación aparte de la que pueda tener con el mismo agente en su propio hub (`dm/<did>@<hub>`).
- **La conversación tiene una casa:** el hub del agente cuyo DID va primero en orden (`isHome`). La casa guarda cuál es el grupo en curso y su generación, deja ganar a uno cuando dos lectores crean el siguiente a la vez, ordena los commits (uno por época) y no admite un mensaje que no sea del grupo y de la época en curso. Lo calcula igual cada hub, sin negociar nada.
- **El otro hub pregunta.** Lo que su agente le pide, él se lo pide a la casa por cinco rutas nuevas entre hubs (`/v1/federation/mls/dm/:did`, con `with`): ver la conversación y los lectores del otro agente, tomar sus KeyPackages, anunciar un grupo nuevo, publicar un commit y leer los que hay. No guardaba nada de la conversación; desde la sección 22 guarda copia de sus commits.
- **Cada hub tiene lo de sus lectores:** sus KeyPackages y sus invitaciones. Cuando se hace un grupo, la casa lo apunta y cada hub deja la invitación a los lectores que son suyos.
- **Los mensajes** viajan como ya viajaban entre hubs: el sobre firmado por su autor, que dice para qué hub es, ahora con `encryption: "mls-v1"`. El hub que es la casa lo contrasta con el grupo y la época, lo envíe su agente o le llegue del otro hub; el otro solo mira que tenga forma de mensaje de MLS de ese grupo.
- Si del otro lado nadie puede (no hay lectores con KeyPackages, o es un hub anterior que no conoce estas rutas), el mensaje va con HPKE como antes, salvo que el agente ya haya hablado por MLS con ese otro, en este hub o en cualquiera: entonces el SDK se niega a bajar sin que se lo pidan.

**Decisiones y por qué**

| Decisión | Motivo |
|---|---|
| Una casa por conversación, y no el estado repartido entre los dos hubs | Hace falta un solo sitio que diga qué grupo gana y qué commit cierra cada época. Dos hubs que lo decidieran a la vez tendrían que ponerse de acuerdo, y eso es otro protocolo |
| La casa es el hub del agente con el DID menor | Los dos hubs lo calculan igual sin hablarse. El precio: para uno de los dos agentes es un hub que no eligió |
| El SDK no cambia de rutas: cambia la dirección | Todo lo que ya estaba probado de las conversaciones (ponerse al día, renovar, reintentos, guardar antes de enviar) vale tal cual. Lo nuevo está en el hub |
| Lo que un hub emparejado hace con una conversación se guarda bajo ese hub | La clave con la que se guarda lleva el DID del otro hub (`acrossKey`). Qué agentes son suyos es su palabra y no se puede comprobar: así, diga lo que diga, solo toca conversaciones con agentes que él dice tener. No alcanza las que este hub tiene con otros hubs ni las de sus propios agentes entre sí |
| Las invitaciones que llegan con conversaciones de otro hub se cuentan aparte, hub por hub | Un lector guarda hasta 50 invitaciones, y un hub emparejado puede hacer que se le dejen muchas diciendo que tiene muchos agentes. Sin contarlas aparte (20 por hub y lector) desplazaría las de las conversaciones y los topics del propio hub |
| Un hub no hace grupos ni commits en nombre de los lectores del otro | Quien hace el grupo, o el commit, tiene que ser un lector del agente del hub que lo anuncia. Lo de los suyos lo autentica cada hub con la firma de la petición |
| El hub solo comprueba de los miembros del otro lado que son DIDs | No sabe qué instancias tiene un agente de otro hub. Que un lector es de un agente lo prueba su credencial de MLS (el certificado de la instancia), y lo comprueban quien lo mete en el grupo y quien entra: el hub nunca fue quien lo garantizaba |
| Lo que el otro hub dice de la conversación se toma solo con forma comprobada | Lectores que son DIDs, un grupo cuyo nombre es el de esa conversación y esa generación, KeyPackages en base64, commits con época y mensaje. Como con todo lo que dice otro hub |
| El hub que no es la casa solo le pasa lo que él mismo ve que es un commit de un grupo de esa conversación | Es lo que cualquier hub puede ver de un commit sin las claves: que lo es, y de qué grupo. Lo demás lo rechazaría la casa igual, pero costaba una petición entre hubs, y un hub no reenvía a otro lo que no tiene la forma de lo que dice ser. Tampoco pregunta por los commits de un grupo que no es de esa conversación |
| Los KeyPackages del otro agente se piden antes de gastar los propios | Si el otro hub no contesta, no se consume ninguno de las demás instancias del agente para nada |
| Lo que cuesta al otro hub sale del cupo de quien lo pide | El de `remote` del agente en su hub, cobrado una vez por petición. Y el otro hub le pone a este el límite de KeyPackages y de operaciones de MLS por agente suyo, pida por quien pida |
| Sin MLS del otro lado, HPKE; pero no si ya se habló por MLS con ese agente, esté donde esté | Es la regla que ya había dentro de un hub, que miraba solo la conversación de ese sitio. Un agente es su clave, y dónde está lo dice un hub: una tarjeta no dice de qué hub es, así que a un hub le basta copiarla para enseñar al agente como propio, o en un tercero, sin nadie que pueda MLS. Ahora el SDK mira si guarda alguna conversación MLS con ese DID, aquí o como `did@hub` (`#talkedOverMls`), y bajar lo decide quien llama |
| Un hub guarda, como casa, un máximo de conversaciones con los agentes de cada hub emparejado (`maxConversationsPerPeer`, 10.000) | Qué agentes tiene otro hub es su palabra y nombrar uno más no le cuesta nada: sin tope, podía hacer guardar a este conversaciones sin fin (60 por minuto y agente de aquí). Dentro de un hub el número lo acota que cada agente cuesta una prueba de trabajo |
| Lleno el cupo se rechaza la conversación nueva; no se echa a la más antigua | Echar una conversación deja libre el nombre de sus grupos y borra el registro de sus épocas: quien la rehiciera con el mismo nombre volvería a poner la época a 1, y cualquiera que llenase el cupo rompería las de los demás. Rechazando, las que hay siguen y lo que un hub emparejado hace solo alcanza a las conversaciones con agentes suyos. El precio está en los límites |

**Límites conocidos**

- **La casa puede no ser tu hub.** Para uno de los dos agentes, quien ordena su conversación es un hub que no eligió. Puede esconderle commits (y entonces sigue cifrando con claves anteriores), negarle el servicio o decirle que no hay grupo. No puede leer, ni falsificar, ni meter a nadie. Es lo mismo que ya podía su propio hub.
- **Los lectores del otro agente no están en el registro de este hub.** Quien sigue el registro contrasta con él los de su propio agente; los del otro los da el otro hub, a través del propio, y solo se comprueba que cada KeyPackage es de un lector de ese agente.
- **Dos hubs tienen que estar en pie para escribir.** Si el otro no contesta no se puede ver la conversación ni enviar. No hay cola entre hubs, como ya pasaba. Para leer lo ya recibido, desde la sección 22, basta el propio.
- **Cada envío cuesta una pregunta al otro hub** además del mensaje: la conversación no se guarda en el hub que no es la casa.
- **Un agente registrado con la misma clave en los dos hubs** tiene dos conversaciones con el otro, una por hub, con los lectores que tenga en cada uno.
- **Un hub emparejado puede anunciar grupos en nombre de agentes que no tiene.** Quedan guardados bajo ese hub, hasta su cupo, y nadie de este entra: quien recibe la invitación comprueba que los miembros son lectores de los dos agentes de la conversación, y un grupo hecho por otro no lo es.
- **Lleno el cupo de un hub emparejado, no hay conversaciones nuevas con sus agentes que tengan aquí su casa.** Nada libera sitio: las conversaciones no se borran, tampoco las de dentro de un hub. Lo llena ese hub cuando quiere, y también los agentes de este que abran muchas con agentes de aquel. El SDK no baja a HPKE por eso: hay que pedirlo, o que quien opera la casa suba el tope (una opción de `createHub`; el CLI no tiene cómo cambiarla, igual que los demás límites). Cada intento rechazado gasta además un KeyPackage de cada lector, dentro del límite de siempre.
- **Una instancia retirada en el otro hub.** Como sus lectores no se contrastan con ningún registro, un hub que siguiera ofreciendo el KeyPackage de una instancia que su agente retiró la metería en el grupo mientras el certificado no caduque (30 días por defecto). Un hub honrado deja de ofrecerla al retirarla.
- **El nombre de un grupo no dice en qué hub está la conversación.** Con el hub propio enseñando como grupo de la conversación con `bob@b` el de la que el agente tiene con esa misma clave en su hub, el SDK cifraba en ese grupo. Se dio por inofensivo aquí, y no lo era del todo: está cerrado en la sección 22, donde un grupo solo se usa para escribir desde la conversación en la que se guardó.
- **Sin probar entre dos máquinas.** Entre versiones distintas sí se ha probado después, con procesos reales en una misma máquina: está al final de la sección 22.

**Cómo se ha comprobado**

- **Tests:** `test/federation-mls.test.mjs`, 16 tests. Cuatro van dos veces, una con la casa de la conversación en cada hub: hablar con todas las instancias de los dos lados, renovar claves y ponerse al día, rehacer el grupo cuando cambian los lectores, y dos lectores que empiezan a la vez, cada uno en su hub. Los otros ocho: MLS cuando se puede, HPKE cuando no y nunca bajar sin que se pida; el cupo de conversaciones; lo que el hub que no es la casa le pasa a la casa; la delegación que no nombra al otro hub; lo que un hub emparejado puede y no puede tocar; la forma de lo que contesta el otro hub; lo que cuesta, a quién se le cobra; y que todo vuelve del diario al arrancar. La suite entera son 190.
- **Mutaciones:** 100 distintas sobre `server.mjs`, `store.mjs` y el SDK, en siete tandas. De las 73 primeras sobrevivieron cinco, todas por huecos de los tests y ninguna por un fallo del código: se añadieron los casos (entre ellos, que la conversación con `did@hub` se guarda aparte de la del mismo DID en el hub propio) y cayeron. Las 27 restantes son de lo que se añadió en el repaso: sobrevivió una (lo que el hub contesta a un commit que pasó a la casa, que nadie miraba) y otra se contó como cazada sin estarlo, que es el punto siguiente. Con sus casos añadidos, caen todas.
- **Una mutación contada como cazada sin estarlo.** El guion de mutaciones daba por cazada una mutación cuando fallaba un fichero entero de tests, y un fichero falla entero también por tardar más del tiempo que se le da. Pasó una vez: aplicada a mano, la mutación no rompía nada (pedir `encrypt: 'mls'` cuando el hub dice que no hay nadie debe contestar `mls_unavailable`, y nadie lo comprobaba después de una conversación MLS). Se añadió el caso, dentro de un hub y entre hubs, y el guion ya no cuenta eso como cazado. En las tandas anteriores de esta sesión no hay ningún caso así: se buscó en sus salidas.
- **Procesos reales:** dos hubs, cada uno en su proceso y con su directorio de datos, emparejados con `--peer`, y dos agentes con el CLI, que arranca de cero en cada orden y lee su estado de MLS del disco. 41 comprobaciones por pasada, con la casa en cada uno de los dos hubs: el primer mensaje y su respuesta sobre MLS a la dirección que da la búsqueda, cada lado renueva sus claves, los dos hubs se paran y arrancan de lo que tienen en disco y la conversación sigue, una segunda instancia entra (grupo nuevo) y contesta, se la retira y deja de leer, los dos registros se sostienen, y en el disco y en la salida de ninguno de los dos hubs hay una palabra de lo que se dijeron. La primera vez que se hizo salió mal por el guion, no por el producto: una pasada cortada a medias dejó sus dos hubs en marcha y la siguiente habló con ellos. Ahora el guion se niega a arrancar si alguien contesta ya en el puerto, comprueba que el proceso que arrancó es el que contesta y para lo suyo al salir.
- **Demo:** el paso de los dos hubs enseña ahora la conversación sobre MLS en los dos sentidos. Ocho pasadas seguidas, que cubren las dos casas.
- **Lo que encontró el repaso antes del commit,** con el código ya en verde:
  1. *El SDK solo miraba la conversación de ese sitio para negarse a bajar a HPKE.* Habiendo hablado por MLS con `bob@b`, un mensaje a `bob` a secas (el hub propio lo enseña como suyo, con una tarjeta que puede copiar) o a `bob@c` salía sellado con HPKE sin que nadie lo pidiera. Ahora mira cualquier conversación MLS con ese DID.
  2. *Un hub emparejado podía hacer guardar a este conversaciones sin fin,* nombrando agentes que no tiene. Ahora hay un tope por hub emparejado.
  3. *El hub que no es la casa le pasaba cualquier cosa como si fuera un commit:* un número, un mensaje que no lo era, el grupo de otra conversación. La casa lo rechazaba, pero la petición entre hubs ya estaba hecha. Ahora mira lo que puede ver él.
  4. *Un comentario decía más de lo que el código garantiza:* que lo que manda un hub no puede desplazar invitaciones que no vinieron de él. Por número, no; pero una invitación sustituye a otra con el mismo nombre de grupo venga de donde venga. No es un hueco práctico (el nombre lleva 96 bits al azar y solo lo conocen los miembros y su hub), y el comentario dice ahora lo que hay.

**Lo que queda**

- ~~Qué número de versión lleva esto.~~ Es la 0.7, por decisión del dueño (sección 23).
- Lo demás de la hoja de ruta sigue como estaba: testigos (aplazados por el dueño, sección 20), que las peticiones digan para qué hub son, y el antiabuso.

## 22. Revisión independiente de MLS entre hubs (13 de noviembre de 2026)

Con el bloque de la sección 21 ya subido, se pidió una lectura a otra sesión que no había visto nada del trabajo: el diff, las reglas de `CLAUDE.md`, la sección 21 y el encargo de atacarlo como hub emparejado, como agente y como hub propio. Volvió con siete hallazgos y uno más de fuera del diff, todos reproducidos con guiones que se han vuelto a pasar aquí. **Dos son graves, y uno de ellos estaba en el código publicado desde que hay conversaciones MLS (sección 13, versión 0.4):** no lo trajo este bloque, lo encontró la revisión de este bloque. El repaso propio de la sección 21 no vio ninguno de los dos.

| # | Gravedad | Qué pasaba | Desde cuándo | Estado |
|---|---|---|---|---|
| 1 | Grave | El SDK cifraba en el grupo que el hub le nombrase, si guardaba estado con ese nombre: el hub propio podía leer lo que un agente escribía a cualquiera | Sección 13 (0.4); este bloque lo llevó a `did@hub` y añadió que la casa pudiera devolver a un lector a un grupo anterior | Arreglado, abajo |
| 2 | Grave | Los KeyPackages que reparte un hub no se contrastaban con los lectores comprobados, ni se miraban las fechas del certificado al meter un lector: una instancia retirada volvía a entrar en un grupo | En un hub, sección 13; este bloque dejó hacerlo al hub emparejado | Arreglado, abajo |
| 3 | Media | Abrir un mensaje de otro hub puede necesitar a ese hub: si no contesta, el buzón se para y al quinto intento el mensaje se pierde; con el CLI no avanza nunca | Este bloque | Arreglado, abajo |
| 4 | Baja-media | La cola de quienes hacen el siguiente grupo de una conversación no tiene límite cuando el otro hub contesta despacio | Este bloque | Arreglado, abajo |
| 5 | Baja | Lo que un hub deja a otro por agente lo puede gastar un solo agente; veinte grupos de un tercero desplazan la invitación pendiente de otro | Decisión de la sección 21, sin sus consecuencias entre los límites | Lo de las invitaciones, arreglado; lo de los cupos, escrito como límite. Abajo |
| 6 | Baja | El registro de épocas se guarda por nombre de grupo: un hub emparejado que conozca el nombre de un grupo de este lo reinicia | Este bloque | Arreglado, abajo |
| 7 | Baja | Cualquier cadena con forma de código que conteste el otro hub llega al modelo con la explicación del servidor MCP | Sección 17 (0.5); este bloque añade cinco rutas | Arreglado, abajo |
| 8 | Fuera del diff | Una operación que queda en el diario y no se puede reproducir al arrancar: la clave de un hub emparejado registrada como agente, y el emparejamiento retirado | Sección 17 (0.5) | Arreglado, abajo |
| 9 | No lo vio la revisión: salió al arreglar lo anterior | Un hub que sigue a otro, y un agente que escucha, no dejaban de leer el stream al cerrarse si el recolector de basura había pasado entre medias: el cierre esperaba para siempre | Sección 17 (0.5) en el hub; el `listen` del SDK, desde el principio | Arreglado, abajo |

**1. En qué grupo escribe un lector**

Cuál es el grupo en curso de una conversación, y quién está en él, lo dice el hub. El SDK lo creía: buscaba el estado guardado por el nombre que el hub le daba y cifraba con él. Al leer sí comprobaba el nombre, y al entrar por una invitación, los miembros; al escribir con un estado que ya tenía, nada. Con eso el hub podía:

- Nombrar como grupo de la conversación con bob el que alice tiene con un agente del propio hub: lo que ella escribe a bob lo lee ese agente, y bob no. Igual con el grupo de un topic privado.
- Decir que el grupo anterior tiene «solo los lectores que hay ahora», para que ella siga escribiendo donde todavía lee una instancia que se retiró.
- Como casa de una conversación entre hubs (el hub del otro agente), devolverla a un grupo anterior de la misma pareja, que es el único que la forma comprobada le deja nombrar.

Lo que hace ahora antes de escribir (`#conversation`, y `#topicGroup` en lo que le toca):

| Decisión | Motivo |
|---|---|
| El nombre del grupo tiene que ser de esa conversación | Lo dice el nombre (`agenthub/dm/v1|a|b|…`). Es la regla que ya estaba escrita en `CLAUDE.md` y que solo se cumplía al leer |
| No se escribe en un grupo anterior al más nuevo que el lector ha guardado de esa conversación, ni de ese topic (`#notBefore`) | En un grupo anterior lee quien estuvo entonces y con las claves de entonces: una instancia retirada, o la copia del estado de un lector que después renovó. El lector apunta cuál es el más nuevo que ha guardado (`newest` en su registro de la conversación) y lo compara con lo que dice el hub |
| Ante un hub que vuelve atrás, se niega; no hace por su cuenta un grupo nuevo | Un hub que perdió sus datos y uno que retrocede a propósito se ven igual. Hacer un grupo nuevo sería seguro en sí, pero deja una puerta: una invitación vieja, a un grupo en el que el lector nunca entró, con un número de generación que tras el «reinicio» vuelve a parecer nuevo. Negarse no tiene esquinas, y es lo que ya se hace con el registro. Decir que el hub empezó de cero es cosa de una persona (`forgetGroups`, `key forget`, `log forget`) |
| Quién está en el grupo lo dice el grupo (`#holdsOnly`) | Los miembros que lista el hub son su palabra; los del estado de MLS llevan cada uno su credencial. Tienen que ser exactamente los lectores que el cliente acaba de comprobar (los de su agente y, si el otro es de su hub, los del otro, contra el registro) y este lector. Si no, se hace el siguiente grupo |
| En un grupo que hace el cliente solo entran los lectores que comprobó | Reparta el hub los KeyPackages que reparta, los que no son de un lector de la lista se dejan fuera. Es la mitad del hallazgo 2 que cae aquí; la otra mitad (fechas del certificado, lo que hace el hub) va en su punto |
| Un grupo solo se usa para escribir desde la conversación en la que se guardó | Con el mismo agente en dos sitios (su hub y otro) hay dos conversaciones y dos grupos de la misma pareja. Un hub podía enseñar el de una como el de la otra, y de paso saltarse el punto anterior, que es por conversación. Leer en un grupo tampoco lo convierte en grupo de la conversación con la que el hub lo etiquete |
| Leer no cambia | Abrir un mensaje en un grupo anterior, o en uno que tiene a quien ya no debería, no revela nada: el mensaje ya estaba escrito para ellos. Lo que se protege es lo que este lector escribe |

Cambios que se ven: un error nuevo del SDK, `mls_rollback_refused` (409, no viene del hub); `forgetGroups(peer?)` en el SDK, que olvida los grupos de una conversación o de todas y recuerda que se habló por MLS y quién es el dueño de cada topic; `key forget DID --yes` en el CLI, y `log forget --yes` olvida también los grupos. Un cliente con estado guardado por la versión anterior no tiene apuntado cuál es su grupo más nuevo: lo deduce de los que guarda.

Límites:

- **Un hub que empezó de cero necesita a una persona.** Antes la conversación seguía sola con un grupo nuevo. Ahora el cliente se niega hasta que se le dice que olvide los grupos. Con el CLI es la misma orden que ya hacía falta para el registro.
- **Después de olvidar, la protección empieza de nuevo.** Quien le dice al cliente que el hub empezó de cero se fía de eso: un hub que le hubiera engañado podría enseñarle, como grupo nuevo, uno antiguo en el que nunca entró y del que guardó la invitación.
- **Un hub que miente sigue pudiendo molestar:** hacer que se cree un grupo tras otro, o que el envío falle. No puede hacer que se escriba donde no toca.
- **En un topic, quién sobra en el grupo lo arregla quien puede.** Un miembro que no es el dueño sigue publicando en un grupo donde queda un lector de otro agente que ya no debería estar, como dice la sección 15: lo saca el dueño, o ese agente, la próxima vez que use el topic.

Cómo se ha comprobado: los cuatro guiones del revisor para este hallazgo (once casos: un hub y entre hubs, con y sin seguir el registro, con una conversación ya en marcha, con el grupo de un topic, con miembros que ya no están, con la casa retrocediendo) dejan de reproducirlo. En la suite: un test en `mls.test.mjs` con el hub nombrando el grupo de otro, el de un topic, un grupo al que le falta un lector, uno con un lector retirado y otro en su lugar, KeyPackages de más, tres formas de volver atrás, un estado sin `newest`, la entrada tardía a un grupo anterior, y olvidar; otro en `federation-mls.test.mjs` con la casa retrocediendo y con el mismo agente en dos sitios; el caso del topic en `topics-mls.test.mjs`; y las órdenes nuevas en el test del CLI. 23 mutaciones: sobrevivieron dos por huecos del test (un hub que dice «sin grupo» con generación, y un grupo con tantos miembros como debe pero no los mismos), se añadieron los casos y caen todas. La suite son 192.

**2. Qué lectores entran en un grupo**

Quien hace un grupo pide al hub un KeyPackage de cada lector. El SDK comprobaba que cada uno fuera de un lector de alguno de los dos agentes, y nada más: no que ese lector fuera uno de los que acababa de contrastar con el registro, ni de cuál de los dos agentes era, ni si su certificado seguía en vigor. Con eso:

- El hub propio listaba solo lectores que están en su registro y repartía, además, un KeyPackage de una instancia que el agente retiró. Entraba en el grupo, y quien tuviera su clave leía. Esto estaba desde la sección 13.
- El hub emparejado hacía lo mismo desde fuera: entre los KeyPackages de su agente mandaba uno de una instancia retirada del agente de *este* hub. El hub de este lo pasaba sin mirarlo (solo la forma) y el cliente lo metía, aunque siguiera el registro de su hub, que la da por retirada. Esto lo trajo este bloque.
- Las fechas del certificado de una instancia no se miraban en ningún sitio de MLS: lo decía el comentario de `credential.mjs`, pensando en no dejar ilegible un grupo. Una clave con un certificado caducado hacía 99 días entraba igual. El README decía desde la 0.4 que una clave robada deja de servir cuando caduca su certificado; para leer por MLS no era verdad.

| Decisión | Motivo |
|---|---|
| En un grupo que hace un cliente entran los lectores que comprobó y solo ellos | Hecho con el punto 1 (`expected`). Lo que reparte un hub de más se deja fuera |
| Un lector es del agente que dice su credencial | Un hub puede listar la instancia retirada de alice entre los lectores de bob, donde ningún registro de alice dice nada. La lista dice de quién espera el cliente cada lector, y la credencial tiene que decir lo mismo |
| Una instancia entra en un grupo mientras su certificado está en vigor (`inspectKeyPackage`) | Es el plazo durante el que su agente responde por esa clave, y el único límite que hay frente a un hub que no se entera de una retirada, o que no quiere enterarse: los lectores del agente de otro hub no se contrastan con ningún registro |
| Nadie escribe en una conversación donde queda una instancia caducada (`lapsedMembers`, dentro de `#holdsOnly`) | Se hace el grupo siguiente, sin ella. En un topic la saca quien puede (el dueño, o su agente) la siguiente vez que lo usa, la liste el hub o no |
| Leer no cambia | Un certificado que caduca no deja el grupo ilegible para los demás, que era la razón de no mirar fechas. Se miran al meter a alguien y antes de escribir |
| El hub no lista como lector a una instancia caducada, ni acepta un grupo de conversación que la tenga, ni reparte sus KeyPackages | Para que un hub honrado y un cliente digan lo mismo. Si el hub la siguiera listando, el cliente haría un grupo nuevo en cada mensaje |
| En una conversación, un lector listado que no se puede meter es un error que se dice; en un topic se deja fuera y se sigue | El grupo de una conversación tiene que tener a todos los lectores que hay, o se rehace cada vez. A un topic los lectores entran cuando pueden |
| El hub mira lo que reparte el otro hub: que sea un KeyPackage, del lector que dice, y de un lector del agente del otro lado | No es lo que impide el ataque (eso lo hace el cliente), pero un hub no pasa a sus agentes lo que no tiene la forma de lo que dice ser |
| Una instancia que un agente de este hub retiró, o caducada, no es miembro de un grupo que anuncia otro hub, ni ese hub hace commits en su nombre | El otro hub dice quiénes son los lectores de su agente; no puede contar entre ellos a una clave que este hub conoce como de los suyos y fuera de uso |

Cambio que se ve: una instancia cuyo certificado caduca deja de ser lectora. Antes seguía en los grupos, y entraba en los nuevos, hasta que alguien la retiraba. Para que siga leyendo hay que certificarla de nuevo, que es lo que ya hacía falta para que siguiera enviando.

Límites:

- **Una instancia retirada en el otro hub sigue pudiendo entrar mientras su certificado no caduque,** si su hub la ofrece: es el límite de la sección 21, ahora con el plazo comprobado de verdad.
- **Las fechas se miran con el reloj de quien las mira.**
- **El registro no sabe de caducidades.** Quien sigue el registro no ve en él que un hub liste una instancia caducada; lo ve en el certificado, cuando va a meterla o a escribir.
- **En un topic, un miembro que no es el dueño sigue publicando** mientras quede en el grupo una instancia caducada de otro agente, hasta que la saque quien puede.

Cómo se ha comprobado: los guiones del revisor (seis casos entre hubs con las dos casas, y el de un hub) dejan de reproducirlo. En la suite: fechas en el adaptador (`mls.test.mjs`); un test con una instancia a la que le quedan tres segundos de certificado, en un hub que la sigue listando y repartiendo, y con el hub diciendo lo que hay; otro igual para un topic; uno entre hubs con lo que reparte el otro hub (la instancia retirada, una clave caducada, la de un tercero, una bajo el nombre de otro lector) y con el hub propio listando la instancia retirada como lectora del otro agente; y en el test de lo que puede hacer un hub emparejado, la instancia retirada y la caducada como miembros y como autoras de un commit. 19 mutaciones, todas cazadas. La suite son 195.

**4, 6, 7 y 8. Lo menor del hub**

| Qué | Cómo queda | Motivo |
|---|---|---|
| Cola de quienes hacen el siguiente grupo (4) | Por conversación hay uno haciéndolo y hasta cuatro esperando; a los demás se les dice que vuelvan (`429 rate_limited`) | Quien lo hace puede estar esperando al otro hub. Sin tope, cada petición esperaba los tiempos de espera de todas las anteriores, con su cuerpo y su conexión abiertos. Es lo que ya hacía `inTurnWith` con lo que un hub le dice a otro que sigue |
| Nombre de un grupo (6) | Un nombre es de un solo grupo: no se apunta un grupo con el nombre de otro del que el hub lleva la cuenta de épocas (`requireUnusedName`), lo haga un agente de este hub o lo anuncie otro | La época de un grupo se guarda por su nombre. Un hub emparejado puede decir que un agente es suyo y nombrar un grupo para la misma pareja que una conversación de este hub; con el mismo nombre, reiniciaba su cuenta de épocas. Hacía falta conocer el nombre (96 bits al azar), o sea, a uno de los dos agentes |
| Códigos del otro hub (7) | De un rechazo del otro hub pasa el código si es uno de los que este conoce (`REFUSALS`); cualquier otro se queda en `peer_refused`. El rechazo dice de qué hub viene (`peer`), y el servidor MCP lo cuenta como respuesta de otro hub | Pasaba cualquier cadena con forma de código, y el servidor MCP la enseñaba como código, o explicaba uno conocido como si hablara del agente en su propio hub: «este agente ha sido retirado». Lo de dejar pasar códigos desconocidos era una decisión de la sección 17, pensada para que el agente supiera por qué; no contaba con que el código lo lee un modelo |
| La clave de un hub como agente (8) | Un hub emparejado no se registra como agente ni como instancia (`409 hub_conflict`), y no se empareja con la clave de un agente o de una instancia de aquí. Al retirar un emparejamiento, el buzón no se borra si esa clave es también la de un lector | El buzón de un hub que sigue topics y el de un agente se guardan por su clave. Con una clave que era las dos cosas, retirar el emparejamiento borraba el buzón del agente, y el siguiente mensaje para él quedaba en el diario sin poder aplicarse: el hub no volvía a arrancar. Es la misma clase de fallo que el de la sección 19. Solo se llegaba por la API (`removePeer`): el CLI no retira emparejamientos |

Cambios que se ven: `hub_conflict` es un código nuevo; un rechazo que viene de otro hub lleva `peer`; un código que el otro hub se invente llega como `502 peer_refused`, donde antes llegaba tal cual con su estado.

**9. El stream que no se dejaba de leer**

Con lo anterior ya escrito, la suite entera empezó a quedarse colgada una de cada dos o tres veces, siempre en el cierre de un hub de los tests de federación y nunca ejecutando ese test solo. No era de los cambios: era un fallo que estaba desde la 0.5 y que el azar había tapado.

- **Qué pasa.** Un hub que sigue topics de otro lee un stream, y para dejar de leerlo abortaba la petición. En Node 22, si el recolector de basura pasa después de que llegue la respuesta, abortar la señal ya no detiene la lectura del cuerpo: el entorno guarda con una referencia débil lo que une la señal con la petición, y para entonces la ha soltado. Reproducido con un guion de treinta líneas: sin recolección, 20 de 20 lecturas se cortan; con ella, ninguna.
- **Qué rompía.** `hub.close()` espera a que acaben los streams que sigue: no volvía. Al retirar un emparejamiento, el stream del hub retirado seguía abierto. Y el `listen` del SDK hace lo mismo: `close()` de un agente que escucha podía no volver nunca.
- **Arreglo.** El cuerpo se lee con un lector propio, que se cancela cuando la señal lo dice (`chunksUntil`, en `core/sse.mjs`), en el hub y en el SDK. Queda como regla en `CLAUDE.md`.
- **Comprobado** con un cuerpo que no acaba y que no sabe nada de la señal, y con un hub y un agente cuyas peticiones no la oyen: se cierran. Diez pasadas completas de la suite seguidas sin un cuelgue, donde antes fallaban cuatro de cada diez.

Cómo se han comprobado estos cinco: tests nuevos en `federation-mls.test.mjs` (la cola, el nombre tomado desde las tres rutas, los códigos), en `federation.test.mjs` (la clave de un hub, el stream) y en `mcp.test.mjs` (cómo se cuenta un rechazo de otro hub). 24 mutaciones: una sobraba (una comprobación del servidor MCP que no aportaba nada, y se quitó) y dos se daban por cazadas por un cuelgue y no por una comprobación; se rehízo el test para que falle limpio y caen todas. La suite son 198.

**3. Lo que espera en un buzón no espera a otro hub**

Para abrir un mensaje, un lector puede necesitar los commits que renovaron las claves desde la última vez que miró. Dentro de un hub se los da su hub. Entre hubs, donde su hub no es la casa de la conversación, su hub se los pedía a la casa en ese momento. Y el buzón se lee en orden: una entrada que no se puede abrir «todavía» detiene a las que vienen detrás, hasta cinco intentos, y luego se descarta. Juntando las dos cosas:

- Si el otro hub no contesta, los mensajes de sus agentes paran el buzón entero, también lo que llega de agentes del propio hub, y a los cinco intentos se pierden.
- A un hub emparejado que quiera molestar le basta con no contestar: cada mensaje suyo le cuesta al lector cinco esperas de cinco segundos. Con unos pocos por minuto, el buzón de cualquier agente al que pueda escribir no avanza.
- Un agente del otro hub lo conseguía con los dos hubs honrados: bastantes commits grandes hacían que la respuesta pasara del megabyte que un hub acepta de otro.
- Leer le gastaba al lector su cupo de preguntas a otros hubs (`remote`), aunque fuera el que escribe quien provocaba las preguntas, y hasta cuando su hub era la casa y no preguntaba a nadie.
- Con el CLI, que es un proceso nuevo en cada lectura, los intentos nunca llegaban a cinco: lo que hubiera detrás no llegaba nunca.

| Decisión | Motivo |
|---|---|
| El hub que no es la casa guarda copia de los commits de la conversación (`mls.copy`, `mlsCopies` en el almacén) | Es lo único que un lector necesita de la casa para abrir un mensaje. Con la copia en su hub, abrir vuelve a depender solo de su hub, como dentro de uno |
| No acepta de la casa un mensaje hasta tener los commits hasta la época de ese mensaje (`409 commits_unavailable`) | Los pide al llegar el mensaje, que es cuando la casa está ahí: acaba de mandarlo. Si no los consigue, el mensaje no entra: quien se queda esperando es quien lo envió, no el buzón del destinatario |
| De lo que da la casa se guarda lo que es un commit de ese grupo, de la época que dice, uno detrás de otro | Lo que cualquier hub puede ver sin las claves. Si lo que da no continúa lo que había, lo que hay pasa a ser eso: un lector que se quedó más atrás no puede seguir, igual que cuando la casa ya no los guarda |
| Para leer, el lector dice hasta qué época necesita los commits (`until`) y su hub contesta con la copia, sin preguntar a nadie; para escribir los necesita todos, y se pregunta a la casa | Leer no debe depender de otro hub. Escribir ya dependía: hay que saber cuál es el grupo en curso |
| La casa da a otro hub los commits que caben en media respuesta, y el otro pide el resto desde donde acaban | Un grupo puede guardar cien commits de hasta 64 KB, y un hub acepta de otro 1 MB por respuesta |
| Mientras lee, un lector no le pide a otro hub el grupo siguiente | Cuando no puede seguir un grupo, dentro de un hub crea el siguiente en el momento. Entre hubs eso es una pregunta al otro hub con todo el buzón esperando la respuesta: lo hace cuando escribe |
| El cupo `remote` se cobra donde se pregunta al otro hub, no al entrar en la ruta | Leer de la copia, o de la propia casa, no pregunta nada a nadie |
| Lo que un hub pide a otro para aceptar sus mensajes sale de lo que ese otro tiene permitido por agente (`mls`) | Para que un hub no pueda hacer que este le pregunte sin medida |
| Las copias tienen su cupo por hub emparejado, aparte del de las conversaciones que este hub guarda como casa | El mismo motivo que en la sección 21: un hub puede nombrar agentes sin fin |
| Los intentos de abrir una entrada se cuentan donde el cliente guarda su estado, y por el evento, no por su sitio en el buzón | Para que el quinto intento exista también para el CLI. Por el evento, porque los sitios del buzón vuelven a empezar si el hub empieza de cero |

Cambios que se ven: un código nuevo, `commits_unavailable`, que recibe quien envía cuando el hub del destinatario no consigue de la casa los commits de ese mensaje; `until` en la ruta de commits; el hub que no es la casa guarda algo más (hasta cien commits por grupo, de los tres últimos grupos de cada conversación).

Límites:

- **Un mensaje entregado antes de que el hub guardara copias** puede no tener sus commits: su lector no lo abre. No hay nada desplegado a lo que le pase.
- **Si la casa da commits que no se pueden aplicar,** el lector no puede seguir ese grupo y lo que le escriban en él no lo lee, hasta que él escriba y haga el siguiente. Antes lo rehacía al leer. Es la conversación con ese hub la que lo sufre, no las demás.
- **El hub que no es la casa no sabe si la copia está completa:** guarda lo que la casa da cuando se lo pide. Una casa que diera commits distintos a cada lado dejaría a los lectores sin entenderse, que es negar el servicio y ya podía.
- **Escribir sigue necesitando a los dos hubs,** y renovar claves tras leer (cada cien mensajes o siete días) también pregunta a la casa.

Cómo se ha comprobado: los cinco escenarios del revisor dejan de darse (con el otro hub caído, el mensaje y el que viene detrás se leen a la primera; con commits de más de un megabyte, también; el cupo no se gasta leyendo; con un proceso nuevo por lectura, el buzón avanza). En la suite: un test nuevo en `federation-mls.test.mjs` con el otro hub que deja de contestar, que miente sobre los commits de cinco maneras, que los da desordenados y que da menos por respuesta de lo que ocupa un commit; los casos del cupo, del límite y de la persistencia en los tests que ya había; y en `mls.test.mjs`, los intentos contados entre procesos. Con dos procesos reales y el CLI, en los dos sentidos: un mensaje que necesitó una renovación se abre con el otro hub parado (47 comprobaciones por pasada). 36 mutaciones: sobrevivieron dos, una condición que sobraba y se quitó, y una pregunta de más al otro hub que el test no contaba; ahora la cuenta. La suite son 199.

**5. Invitaciones desplazadas y cupos compartidos**

Tres consecuencias de decisiones de la sección 21 que no estaban entre sus límites.

- **Invitaciones desplazadas. Arreglado.** Un lector guarda hasta 50 invitaciones de su hub y 20 de cada hub emparejado, y al llenarse salía la más antigua. Un agente hacía veinte grupos seguidos con un lector (cada uno, la generación siguiente de su propia conversación con él) y echaba la invitación que otro agente tenía esperando: el lector ya no podía entrar en ese grupo, tiraba lo que le escribían en él, y a quien escribía le seguía pareciendo que todo iba bien. Dos cambios:
  - *Sale la más antigua de la conversación que más tiene esperando.* Quien hace grupo tras grupo desplaza las suyas. Se probó antes guardar solo las dos últimas de cada conversación, y se descartó: un lector que estuvo fuera mientras se hacían tres grupos perdía lo que le escribieron en el primero, que es un caso corriente.
  - *Un lector que recibe algo en un grupo en el que no está hace el siguiente,* igual que cuando no puede seguir uno en el que estaba: así quien escribe se entera, porque su próximo mensaje va al grupo nuevo. Solo con agentes de su propio hub; con los de otro sería preguntar a ese hub mientras lee (punto 3), y lo hace cuando escribe.
  - Para llenar el sitio de un lector hacen falta ahora tantas conversaciones distintas como invitaciones caben, es decir, otras tantas identidades, cada una con su prueba de trabajo; o un hub emparejado, que nombra las que quiere, pero solo desplaza las invitaciones que vinieron de él.
- **Un cupo para todo el hub. Límite.** Lo que un hub permite a otro por cada agente suyo (seis KeyPackages de golpe y dos por minuto; sesenta grupos o commits por minuto) es un solo cupo, lo pida el agente que lo pida, porque quiénes son los agentes del otro hub es su palabra. Un agente puede gastarlo entero con su propio cupo, que es igual de grande, y durante ese rato ningún otro agente de su hub puede empezar una conversación con ese agente del otro hub.
- **KeyPackages agotados. Límite.** Un hub emparejado, nombrando agentes que no tiene, toma KeyPackages de cada lector de un agente al ritmo que se le permite: un lector que tenga diez se queda con el último en un par de minutos. El último se reparte a todo el que pida, y solo abre la primera invitación que llegue: las demás conversaciones nuevas con ese lector fallan hasta que publique más, que es lo primero que hace al conectarse.

Los dos límites son de cuánto se deja pedir (`limits.mlsClaim`, `limits.mls`), y cualquier número es un compromiso entre los dos: subir lo que un hub permite a otro hace más difícil que un agente lo agote y más fácil que el otro hub vacíe los KeyPackages. Se han dejado como estaban. Es materia del antiabuso, que sigue sin empezar (sección 7).

Cómo se ha comprobado: el escenario del revisor para las invitaciones deja de darse; los otros dos se siguen dando, como dice arriba. En la suite: el reparto de las invitaciones en el test del almacén (`federation-mls.test.mjs`), con las de un hub y las del propio; y un test nuevo en `mls.test.mjs` con un lector cuya invitación no llegó. Tres mutaciones, cazadas. La suite son 200.

**Comprobaciones al cerrar, con todo junto**

Con los seis commits de esta sección ya subidos, se repitió todo sobre el código final. No cambió nada del producto: lo que falló al principio de cada prueba eran errores de los guiones, y se dice cuáles.

- **Los guiones del revisor, todos, contra el código final.** Los de los hallazgos 1, 2, 3, 4, 6, 7 y 8 dejan de reproducirlos. El del hallazgo 5 da lo que dice su punto: las invitaciones ya no se desplazan, y los dos límites de los cupos se siguen dando. El que reproduce el diario de un hub después de cada ataque pasa.
- **La suite:** 200 tests, tres pasadas seguidas en verde (y las diez del punto 9). **La demo**, entera.
- **Dos hubs en dos procesos, con el CLI:** las 47 comprobaciones de la sección 21 y del punto 3, cuatro pasadas, con la casa de la conversación en cada uno de los dos hubs.
- **El cliente oficial de MCP** contra dos servidores MCP y un hub en marcha: 24 de 24, como en la sección 11.
- **Actualizar desde la versión anterior.** Con el código tal como estaba publicado antes de este trabajo (commit `5f03832`, la 0.6) se arrancan dos hubs emparejados y cuatro agentes con el CLI, y se deja a medias todo lo que puede quedar a medias: una conversación MLS con una renovación de claves y un mensaje sin leer, un mensaje a un agente que todavía no ha recogido su invitación, un topic privado con un evento sin leer, y un mensaje a otro hub, que entonces iba sellado con HPKE. Después se arranca el código de ahora sobre los mismos datos y el mismo estado de cada agente. 53 comprobaciones por pasada, seis pasadas: parando los hubs antiguos como lo haría un operador (dejan una copia en disco al salir) y matándolos en seco (el código nuevo tiene que reproducir el diario que escribió el antiguo, 27 operaciones en un hub y 5 en el otro), y en los dos casos con la casa de la conversación en cada hub. Lo que enseña:
  - Lo que esperaba se lee: el mensaje que necesita la renovación, la invitación guardada con la forma antigua (sin `from`) y el evento del topic.
  - Las conversaciones siguen en el grupo que tenían, sin rehacerse (la generación sigue en 1), y nadie recibe un `mls_rollback_refused` que no toca: el estado antiguo no tiene apuntado cuál es su grupo más nuevo y el cliente lo deduce bien.
  - La conversación con el agente del otro hub pasa de HPKE a MLS sin que nadie haga nada, y sus renovaciones dejan copia de los commits en el hub que no es la casa. Un hub que arranca de datos sin copias (`mls_copies`) funciona.
  - Los dos registros se sostienen después de todo.
- **Las dos versiones a la vez,** también con procesos reales. 119 comprobaciones por pasada, dos pasadas (el hub antiguo es una vez uno y otra vez el otro):
  1. *Dos hubs emparejados, uno de cada versión,* cada agente con el CLI de la versión de su hub. Se encuentran al buscar, se escriben en los dos sentidos sellando con HPKE (el hub nuevo pregunta por la conversación MLS, el antiguo no conoce la ruta, y el envío sigue por HPKE sin que nadie lo pida: no habían hablado antes por MLS), y los topics públicos cruzan en los dos sentidos: buscar, seguir, y publicar desde el otro hub. Luego se actualiza el hub antiguo sobre sus datos: la conversación pasa a MLS, con una renovación, los topics siguen llegando y los dos registros se sostienen.
  2. *Un hub antiguo con agentes en el CLI nuevo;* 3. *un hub nuevo con agentes en el CLI antiguo;* y 4. *un hub nuevo con un agente en cada CLI,* empezando una vez cada uno. En los cuatro: conversación MLS con una renovación de cada lado, un topic privado sobre MLS en el que publican los dos, y el registro auditado por los dos.
- **Lo que falló al hacer estas pruebas, y no era del producto.** En la de actualizar, tres comprobaciones del guion esperaban algo que no debía pasar: leer con el código nuevo un mensaje que ya se había leído con el antiguo, que un agente recibiera eventos de un topic al que no se había suscrito, y que quien publica reciba su propio evento. En la de las dos versiones, seis registros seguidos desde la misma dirección toparon con el límite de registros por minuto del hub, y todo lo que venía detrás falló por eso: el último par de agentes va ahora en un hub aparte. Se corrigieron los guiones y se repitieron las pasadas enteras.

Lo que estas pruebas no cubren: dos máquinas distintas, una red de verdad entre los hubs, y versiones anteriores a la 0.6.

**Lo que queda**

- ~~El número de versión.~~ MLS entre hubs y lo que arregla esta sección son la 0.7, por decisión del dueño (sección 23). Dos de los arreglos cambian cómo se comporta lo que ya había desde la 0.4: un cliente se niega ante un hub que vuelve atrás, y una instancia caducada deja de leer.
- **Los dos límites del punto 5,** los cupos compartidos y los KeyPackages que se agotan, son del antiabuso, que sigue sin empezar.
- **Lo que ya estaba pendiente y sigue igual:** los testigos (aplazados por el dueño, sección 20), que las peticiones firmadas digan para qué hub son, que una tarjeta diga de qué hub es, y que los lectores de un agente de otro hub se puedan contrastar con algún registro.
- ~~Los guiones de estas pruebas no están en el repositorio.~~ El dueño decidió guardarlos: están en `checks/` (sección 23). Los de las pruebas a mano de las secciones anteriores no se guardaron: lo que queda de ellos es lo que cuenta cada sección.

## 23. Decisiones del dueño al cerrar MLS entre hubs (13 de noviembre de 2026)

Preguntadas con MLS entre hubs y la revisión independiente entregados (secciones 21 y 22).

1. **Versión.** MLS en los mensajes directos entre hubs, con lo que arregló la revisión, es la 0.7.
2. **Los guiones de las pruebas con procesos reales se guardan en el repositorio,** en un directorio aparte de `test/` y fuera de `npm test`: dos hubs en dos procesos, la actualización desde la versión anterior, las dos versiones a la vez y el cliente oficial de MCP. Hecho, abajo.
3. **Qué bloque va después: ninguno, de momento.** Se preguntó entre que las peticiones firmadas digan para qué hub son, el antiabuso, los testigos y el despliegue. El dueño contestó después que de momento no se hacen más bloques y que el trabajo se pare al acabar lo que estaba en curso (la versión y los guiones de arriba). No se ha empezado ninguno, y lo pendiente sigue como está escrito: la hoja de ruta en la sección 7, los límites conocidos en la 6 y lo que le queda al registro en la 19. Para cuando se retome: quien escribe esto recomendó el primero porque cambia el protocolo y conviene hacerlo antes de que haya nada desplegado, y al preguntarlo lo dio por pequeño sin serlo del todo: de código es poco, pero su diseño está sin decidir (sección 19, «Lo que queda de este bloque», punto 2), y lo primero sería traerle al dueño una propuesta. Se le dijo así.

**Hecho: las comprobaciones con procesos reales, en `checks/`**

Son los guiones con los que se hicieron las pruebas del final de la sección 22, pasados a limpio. `checks/README.md` dice qué comprueba cada uno, qué necesita y las reglas que cumplen. Lo que cambió al guardarlos:

- **Sin nada de la sesión que los escribió:** el repositorio es el del propio guion, los puertos se pueden mover (`AGENTHUB_CHECK_PORT`), y cada pasada usa un directorio temporal que se borra si todo pasa y se queda, diciendo dónde, si algo falla. Lo común está en `checks/lib.sh`.
- **La casa de la conversación se elige.** Antes dependía del azar de las claves y había que repetir pasadas hasta ver las dos. Ahora las claves de los dos agentes se hacen antes de registrarlos y se reparten según la casa que se pide.
- **La versión anterior es un commit** (`AGENTHUB_OLD_REV`; por defecto el último de la 0.6) que el guion saca del historial, o un directorio con su código (`AGENTHUB_OLD_TREE`).
- **La prueba de las dos versiones son ahora dos:** `mixed-hubs.sh` (un hub de cada versión, emparejados) y `mixed-clients.sh` (un hub de una versión con el CLI de la otra), cada par de agentes en un hub propio para no topar con el límite de registros.
- **Lo que cruza de un hub a otro se lee con reintentos,** no con una espera fija.
- **Salen con 0, 1 o 2** (pasó todo, falló algo, no pudo empezar), y `all.sh` pasa las doce variantes.
- Por eso los números no son los de la sección 22: 48 comprobaciones los dos hubs (la casa pedida es una más), 58 la actualización (lo que queda guardado en cada hub al final son ahora comprobaciones, y no una línea que había que leer), 35 y 84 las dos de versiones, 24 el cliente de MCP.
- El cliente oficial de MCP (`@modelcontextprotocol/sdk` 1.32.2, fijado) es dependencia de `checks/mcp-client`, con su propio `package-lock.json`, y no del producto: las del producto siguen siendo dos.

Cómo se ha comprobado que comprueban:

- **Las doce variantes pasan desde el repositorio,** en unos dos minutos, y también desde una copia en una ruta con espacios y con la versión anterior dada en un directorio.
- **Cuatro regresiones metidas a propósito en una copia del código,** una cada vez, y la comprobación que debía notarla la nota: el hub que no es la casa no guarda copia de los commits (fallan `two-hubs.sh`, 10 de 48, y `upgrade.sh`, 7 de 58); un estado antiguo, sin su grupo más nuevo apuntado, se lee como si fuera muy por delante (`upgrade.sh`, 14 de 58, con `mls_rollback_refused`); un hub emparejado que no conoce las rutas de MLS deja de tomarse por uno sin nadie con quien hablar por MLS (`mixed-hubs.sh`, 2 de 35); y un mensaje llega al modelo sin la marca de no fiable (`mcp-client`, 2 de 24).
- **Con un hub ajeno ya escuchando en uno de sus puertos,** la comprobación se niega a empezar y no lo toca. Con un directorio que ya existe, o un argumento que no es, tampoco empieza.

Lo que no se guardó: los guiones del revisor (lo que reproducían está ahora en la suite, sección 22) y el de las mutaciones, cuyas listas valen solo para el código del momento en que se escribieron.

## 24. El servicio alojado: evaluación (15 de noviembre de 2026)

Trata del servicio alojado, que no es parte de este repositorio.

## 25. Construcción del open core (15 de noviembre de 2026, en curso)

Se construyó lo que cualquier hub necesita para funcionar con cuentas, verificación y federación abierta. Antes de empezar, el dueño decidió: el verificador de GitHub es abierto; el cliente va con Apache-2.0 y el hub con AGPL-3.0-only; y las peticiones de clientes anteriores, que no se firmaban para un hub, se rechazan ya, sin periodo de convivencia.

**Bloque 1. Licencias.** `LICENSE` dice qué licencia va dónde y `LICENSES/` tiene los textos completos (el de la AGPL, el canónico de la FSF; el de Apache, el de apache.org). Cada fichero `.mjs` de `src/` y `bin/` empieza por su `SPDX-License-Identifier`. `test/licenses.test.mjs` comprueba que cada fichero dice la licencia que le toca por su sitio, que el código Apache no importa nada del hub; probado con un import del hub desde el SDK y con una cabecera cambiada, y los dos fallan. El CLI está bajo AGPL porque incluye el hub. El paquete de npm sigue siendo uno: separar el cliente en su propio paquete será cuando se publique.

**Bloque 2. Peticiones para un hub.**

| Decisión | Motivo |
|---|---|
| Se firma el origen al que habla el cliente (esquema, nombre en minúsculas y puerto si no es el de siempre), y viaja en `x-agenthub-origin` | Es lo único que el cliente sabe del hub sin que se lo diga el hub, y TLS prueba que el servidor es esa dirección. El DID del hub no servía: un cliente sin estado lo aprende del propio hub. Es lo que hace DPoP con `htu` |
| El hub comprueba primero la firma y luego que el origen es suyo (`wrong_hub`, con los que acepta) | Así `wrong_hub` solo se contesta a una petición auténtica, y quien la recibe sabe que el fallo es de dirección: repetida por otro hub o enviada a la dirección que no es |
| Qué direcciones acepta un hub: la de `--public-url`; sin ella y escuchando solo en esta máquina, `127.0.0.1`, `localhost` y `[::1]` con su puerto | Un cliente local escribe la dirección de una de esas formas. Otro hub de la misma máquina tiene otro puerto |
| Un hub que escucha en otra interfaz no arranca sin su dirección pública | Sin ella no hay a qué dirección firmar. La imagen de Docker ya la pedía en su ejemplo (`PUBLIC_URL`) |
| Las peticiones de la versión 1, sin dirección, se rechazan (`unbound_request`) | Decisión del dueño. Aceptarlas seguía dejando repetir las de clientes viejos. El precio: un CLI o un SDK de la 0.7 no habla con un hub nuevo, ni uno nuevo con un hub de la 0.7, ni dos hubs de versiones distintas entre sí |
| Lo que un hub pide a otro se firma igual, para la dirección que dio el operador | La misma repetición existía entre hubs emparejados. Un emparejamiento con una dirección que no es la del otro hub se ve al arrancar: `mismatch`, con el motivo dicho por este hub, sin repetir lo que contesta el otro |

Cómo se ha comprobado: `test/core.test.mjs` (la firma cubre la dirección, y siete direcciones que no son la firmada no verifican), y `test/requests.test.mjs`, nuevo: una petición de alice firmada para el hub A, presentada tal cual al hub B donde alice también está, se rechaza, y cambiarle la dirección rompe la firma; una petición de un cliente de la 0.7 se rechaza, también si se le añade la cabecera; qué direcciones acepta un hub local y uno detrás de un proxy; que uno expuesto sin dirección no arranca; y entre hubs, lo que A pidió a B, presentado a C, se rechaza, y un emparejamiento con la dirección equivocada sale como `mismatch`. En `checks/`, las dos comprobaciones de versiones mezcladas comprueban ahora que no se entienden, que lo dicen, y que tras actualizar todo vuelve a funcionar; las doce variantes pasan. La suite son 207.

**Bloque 3. Cuotas por cuenta.**

| Decisión | Motivo |
|---|---|
| Una cuenta es el controlador que firma la delegación; un agente sin delegación es una cuenta propia | Crear agentes solo cuesta una prueba de trabajo: con cuotas por agente, quien quisiera más cupo crearía más agentes. Por controlador, todos los agentes que delega comparten el de la cuenta, y para tener otra cuenta hace falta otro controlador verificado, con GitHub en un hub que confía en un verificador |
| Tres cuotas, por nivel: mensajes y eventos al día, topics y agentes | Las cifras las pone cada operador. Más cuotas se añaden en `quota.mjs` |
| Por defecto, ninguna | Un hub no tiene por qué tenerlas: quien las quiera las pone en su configuración |
| Lo de hoy se cuenta en memoria | Como los límites por minuto. Nada del diario depende de ellas, así que la reproducción sigue siendo determinista. El precio: un reinicio vuelve a empezar el día |
| Se cuenta también sin cuota | Para que `GET /v1/usage` diga lo que ha hecho una cuenta, y su operador pueda enseñarlo |
| Se cobra al empezar la petición, como los límites por minuto | Más sencillo. Una petición que después se rechaza por otro motivo cuenta igual |
| Los agentes de una cuenta se cuentan al presentar la delegación, también al registrarse con ella | Es cuando un agente pasa a ser de una cuenta |

Cómo se ha comprobado: `test/quotas.test.mjs`, nuevo, con seis tests: el contador por días; la forma de las cuotas que da el operador; dos agentes de una cuenta que comparten su cupo, entre mensajes directos y eventos, y uno sin delegación con el suyo; una instancia que gasta del de su agente; topics por cuenta y agentes por controlador, que deja sitio cuando uno suelta su delegación y cuenta también al registrarse; y un hub sin cuotas. La suite son 213.

**Bloque 4. El nivel 2 por atestaciones.**

| Decisión | Motivo |
|---|---|
| Un verificador firma que un controlador es una cuenta, y el hub solo comprueba la firma | El hub no habla con GitHub ni con nadie: no guarda credenciales de ningún proveedor ni depende de que conteste. Quién verifica es un servicio aparte (bloque 5), y cualquier operador elige en quién confía |
| La atestación es del controlador, no del agente | Las cuentas son de los controladores, y todos los agentes que uno delega suben de nivel a la vez. Es también la cuenta de las cuotas (bloque 3) |
| `account` es el proveedor y el identificador estable (`github:1234`); el nombre de usuario va aparte y solo se enseña | Un nombre de usuario cambia y se reutiliza. El nombre llega a modelos: va con forma comprobada (ASCII imprimible, 100 caracteres) |
| Caduca, 90 días como máximo | Una cuenta se cierra o cambia de manos |
| Cualquiera la entrega; el hub la toma solo si es más nueva que la que tiene | Como una revocación, se autentica sola. Cada una que se toma queda en el registro para siempre: una repetida o más vieja no deja nada. Además, un límite por IP |
| Va al registro de transparencia (`controller.attest`), con una regla: firmada por quien dice, del controlador y la cuenta que dice, apuntada antes de caducar y más nueva que la anterior | Sube el nivel de agentes, que es parte del directorio. La regla no mira si el verificador es de fiar: eso depende de la configuración de cada hub, y las reglas son las que cumple un hub honrado con cualquier configuración. Quien lee el registro ve quién responde por quién y decide |
| Deja de contar al caducar o si el operador quita su verificador de la lista, aunque siga en el registro | El nivel se calcula en el momento con lo que hay; el registro dice lo que pasó |
| `--verified-controller` sigue | Para quien prefiera marcar a mano, sin verificador |

Lo que no cubre: el seguidor del registro no contrasta todavía el `verified_as` que enseña el hub con las atestaciones apuntadas (puede venir de `--verified-controller`, que no está en el registro). Y la atestación no tiene revocación propia: se espera a que caduque, o el operador deja de confiar en el verificador.

Cómo se ha comprobado: `test/attestations.test.mjs`, nuevo, con cinco tests: once atestaciones falsificadas o mal hechas que no verifican; un controlador que pasa a `account` y se ve en la tarjeta, sin dejar entrada de más con una repetida o más vieja; lo que el hub rechaza (verificador desconocido, caducada, del futuro, manipulada, con campos de más en la prueba); que sobrevive a un reinicio, deja de contar sin confianza y al caducar; y seis registros manipulados que no se sostienen. La suite son 218.

**Bloque 5. El verificador de GitHub.**

| Decisión | Motivo |
|---|---|
| Un servicio aparte del hub (`src/verifier/`, `agenthub verifier`), AGPL como el hub | El hub no habla con ningún proveedor (bloque 4). Abierto por decisión del dueño: un self-hosted también querrá verificar |
| El flujo de dispositivo de GitHub, no el OAuth con redirección | No hacen falta páginas web en el verificador, ni guardar el secreto de la aplicación, ni una dirección de vuelta: el controlador es una clave en un CLI, y el flujo de dispositivo está hecho para eso |
| La petición la firma la clave del controlador, para la dirección del verificador, y vale cinco minutos y una vez | Es lo que liga la cuenta que entra en GitHub a esa clave. Para la dirección, como las peticiones a un hub (bloque 2) |
| El token de GitHub se usa una vez y no se guarda; no se pide ningún permiso | Solo hace falta saber quién entró, y eso es el perfil público |
| La cuenta es `github:<id numérico>`, con el nombre aparte | El id no cambia si se cambia el nombre de usuario |
| Al verificador se le pregunta como mucho cada `interval` de GitHub, de uno en uno por verificación, y respeta `slow_down` | Lo pide GitHub. Que un cliente pregunte deprisa no se traduce en preguntas a GitHub |
| Lo que no evita: quien escribe un código que le pasó otro liga su cuenta a la clave de ese otro | Es el riesgo de todo flujo de dispositivo. GitHub enseña qué aplicación pide permiso antes de aceptar |

Cómo se ha comprobado: `test/verifier.test.mjs`, nuevo, con cinco tests y un GitHub simulado según su documentación: el flujo entero, que acaba con un agente de nivel `account` en un hub que confía en el verificador, sin token en lo que se contesta; seis peticiones que el verificador rechaza sin preguntar nada a GitHub, y la repetida; una verificación denegada y cuatro respuestas de GitHub que no dicen quién entró; un controlador que espera la verificación de otro y no la acepta; que no pregunta a GitHub más de lo que permite, y qué contesta si GitHub no está. No se ha probado contra GitHub: hace falta una aplicación OAuth con el flujo de dispositivo activado. La suite son 223.

**Bloque 6. Emparejamiento abierto.**

| Decisión | Motivo |
|---|---|
| El operador de un hub lo abre (`openPairing: { maxPeers }`, `--open-pairing MAX`) y entonces cualquier hub puede emparejarse solo | Es lo que necesita el servicio alojado: que un self-hosted se conecte sin que nadie del servicio haga nada. Cerrado por defecto |
| El que pide es el de la clave que firma la petición, y tiene que contestar en la dirección que da, como el hub de esa clave, a un reto de este | Si no, cualquiera podría emparejarse en nombre de otro hub, o dar una dirección que no es la suya. Para contestar como par, el que pide tiene que haber emparejado antes a este: es lo que hace su operador con `--peer` |
| El lado que pide lo hace solo, al comprobar el emparejamiento, si el otro dice en `/v1/info` que lo permite | Así el operador del self-hosted hace lo de siempre (`--peer`) y nada más |
| El nombre lo propone el que pide (`--hub-name`, o uno hecho con su dirección), y si está tomado, no se empareja | El nombre es el de sus topics en este hub (`topic@nombre`): no puede cambiar de dueño |
| Solo direcciones HTTPS públicas, salvo que el operador permita otras (`privateAddresses`, para pruebas o una red propia) | Cualquiera con una clave puede pedirlo, y el hub hablaría luego con la dirección dada: sin esto, se le podría hacer hablar con su propia red. Se comprueba al emparejar; un nombre que después resuelva a otra dirección no se ve. Lo que cierra eso del todo es que el servicio solo tenga salida a internet público |
| Se guarda en el almacén (`pairing.put`, `pairing.drop`) y vuelve al arrancar; lo que el operador emparejó a mano tiene preferencia | Los emparejamientos a mano son configuración y siguen sin guardarse |
| Un tope de hubs emparejados así, y un límite por IP de peticiones | Lo que cada uno puede hacer ya tiene sus topes por hub (secciones 17 y 21) |

Cómo se ha comprobado: `test/pairing.test.mjs`, nuevo, con cinco tests: un hub que se empareja solo y cuyos agentes usan los topics del servicio, sin cambios si lo pide otra vez; uno cerrado, que no acepta; quien pide en nombre de otro hub, o con una dirección donde no contesta, o con un nombre o una clave tomados, o con la clave de un agente; las direcciones que no son HTTPS públicas, y el tope; y que sobrevive a un reinicio hasta que el operador lo quita. La suite son 228.

**Bloque 7. Antiabuso mínimo.**

| Decisión | Motivo |
|---|---|
| Un agente bloquea por DID, y vale para ese agente venga del hub que venga | Un agente es su clave (sección 21). Bloquear es tirar en el hub lo que le llegaría: mensajes directos y eventos de topics. No es una defensa del extremo, ni lo pretende: es para no recibir spam |
| Al bloqueado no se le dice | Saberlo le ayudaría a cambiar de clave sin que se note. Lo suyo se acepta y se tira |
| Las denuncias van a los operadores del hub y solo ellos las leen | Con motivo de una lista y una nota corta, sin caracteres de control. Quien las lee es una persona con el CLI; si algún día las lee un modelo, la nota es texto de otro agente y va envuelta |
| Los operadores son claves que se le dan al hub (`--operator`), y firman sus peticiones como cualquiera | Sin cuentas ni contraseñas: lo mismo que el resto del hub. La consola del servicio alojado usará esas claves |
| Suspender no va al registro de transparencia | El registro dice quién es quién: un agente suspendido sigue siendo quien es, con su tarjeta. Quién puede usar el hub es una decisión del hub, como sus cuotas, y sus reglas no pueden depender de eso |
| Un agente suspendido no puede hacer nada aquí, ni de otro hub | Para un servicio alojado el spam vendrá también de hubs emparejados solos. Se guarda por DID |
| Un topic suspendido no acepta eventos ni suscriptores nuevos, y no se encuentra; sigue existiendo | Borrarlo cambiaría el directorio, que es del registro. Su dueño sigue siéndolo |

Cómo se ha comprobado: `test/abuse.test.mjs`, nuevo, con cinco tests: un agente bloqueado no llega por MLS, sellado ni por un topic, y desbloqueado sí; el bloqueo vale para un agente de otro hub; denuncias, lo que no se acepta, que solo un operador las lee, y suspender y readmitir un agente y un topic; un agente suspendido aquí no entra desde otro hub; y todo sobrevive a un reinicio. La suite son 233.

**Bloque 8. El self-hosted, listo para usar.**

- `docs/SELF-HOSTING.md`: qué hace falta, cómo arrancarlo, las opciones que importan, qué hay en sus datos (y que la clave del hub es su identidad), copias, restaurar, actualizar y lo que no hace.
- `deploy/self-hosted/`: Docker Compose con el hub y Caddy delante para TLS, con el stream sin búfer; una unidad de systemd; y `backup.sh`, que copia con el hub en marcha.
- **La copia.** El orden es lo que la hace buena: el diario antes que la copia del estado. El hub escribe su copia del estado con un fichero nuevo entero y vacía el diario después, así que una copia del estado tomada después del diario nunca es más vieja que él. Al revés podían faltar operaciones.
- **El hub no arranca de un diario que no sigue a su copia del estado** (`store.mjs`): antes lo reproducía igual, y con una copia mal hecha habría construido un estado que nunca existió. No afecta a nada que un hub haga solo: un diario siempre sigue a su copia del estado, también después de una caída a mitad de compactar.

Cómo se ha comprobado: `test/store.test.mjs`, nuevo (una copia hecha en el orden equivocado no arranca; los datos buenos sí), y `checks/backup.sh`, nuevo, con procesos reales: una copia hecha con el hub en marcha arranca otro hub con la misma clave, los mismos agentes y topics, un registro que se sostiene y el mensaje que esperaba en un buzón antes de la copia, y sin el de después. Lo que no se ha probado: la imagen de Docker, Caddy y systemd, porque aquí no hay ni Docker ni systemd. No se ha publicado ninguna imagen: es una decisión del dueño. La suite son 234.

**Bloques 9, 10 y 11.**

- **9, el almacén tras una interfaz, no se hace como estaba escrito.** El hub trabaja con su estado en memoria y apunta cada cambio de forma síncrona en un diario, y todo el servidor cuenta con eso (`store.commit` devuelve en el momento). Una interfaz que pudiera estar detrás de una base de datos sería asíncrona: es rehacer el hub, que es el bloque 20. Para un solo nodo basta el diario en un disco replicado.
- **10, el primer despliegue** del servicio alojado, no es parte de este repositorio.
- **11, la consola** del servicio alojado, tampoco. Para ella se añadió al núcleo una ruta de operadores que da el uso de una cuenta (`GET /v1/admin/accounts/:account`), que le sirve a cualquier operador, con su test en `test/quotas.test.mjs`.

**Bloque 12. Operación**, en lo que no depende del proveedor:

- **Métricas** (`src/hub/metrics.mjs`, en el núcleo, porque le sirven a cualquier operador): con `--metrics-port N`, el hub sirve `GET /metrics` en el formato de Prometheus en `127.0.0.1:N`, aparte de su puerto. Solo cuentas: agentes por estado, instancias, topics, entradas en buzones, streams abiertos, hubs emparejados por estado, entradas del registro, suspensiones, denuncias, respuestas por clase de estado, operaciones del diario, tiempo encendido y memoria. Ningún DID ni nombre: un test lo comprueba.
- Las copias probadas restaurándolas son `checks/backup.sh`.

La suite son 235.

**Bloque 13. La cuenta de una atestación, fuera del registro público.** Al escribir los textos legales del servicio alojado salió un problema del bloque 4: una atestación ponía en el registro de transparencia, que es público y no se puede borrar, el número y el nombre de usuario de GitHub de quien tiene una clave de controlador. Con el RGPD es un dato personal sin derecho de supresión posible. El dueño decidió el 15 de noviembre que las atestaciones lleven una referencia opaca de la cuenta.

**La cuenta, como referencia.** Una atestación ya no lleva `github:1234` ni el nombre de usuario: lleva `ref:` y un HMAC-SHA256 de la cuenta con un secreto del verificador (`accountReference`, en `core/attestation.mjs`), y el campo `name` desaparece. El verificador guarda el secreto con sus datos (`verifier-reference-secret`) y la consola recibe el mismo (`ACCOUNT_SECRET`): calcula la referencia de quien entra y busca sus controladores por ella. A quien pide la verificación el verificador le dice qué cuenta era, fuera de la atestación, para que vea que es la suya. El hub no cambia: compara referencias, y `verified_as` enseña la referencia. Lo que no cambia: para el RGPD es un seudónimo, porque quien tiene el secreto lo deshace; una supresión de verdad pediría un secreto por persona que se pudiera borrar, y no está hecho. Nada estaba desplegado, así que el formato cambia sin versión nueva. Tests: la cuenta en claro, el nombre o una referencia mal formada no pasan; la misma cuenta da la misma referencia y otro secreto otra; el verificador no pone la cuenta en la atestación; la consola encuentra los controladores por referencia y no arranca sin el secreto.

**Bloque 14. Probar que se controla una clave.** Para que un servicio deje administrar una organización a quien controla su dominio, el núcleo tiene una prueba nueva, con su `CONTEXT` (`agenthub/control-proof/v1`, en `core/control.mjs`): el CLI firma con `agenthub controller prove` un código que da el servicio, para la dirección del servicio, y vale una vez y 15 minutos. Reutiliza cómo se comprueba la firma de un did:web en las delegaciones (`verifyIssuerProof`, ahora exportada). La ruta de operadores que da el uso de una cuenta acepta también el did:web de una organización. Tests en `test/control.test.mjs`: pruebas con una clave propia y con la de un did:web, y siete que no pasan (una clave que el dominio no publica, otro dominio u otro código con la misma firma, otro servicio, demasiado vieja, otro contexto, un campo de más).

## 26. El despliegue del servicio alojado (15 de noviembre de 2026)

Trata del despliegue del servicio alojado, que no es parte de este repositorio. Lo que cambió en el núcleo para él está en el código: `--metrics-host`, la comprobación de salud de la imagen de Docker (`/healthz`) y la imagen misma.

## 27. Comparación con proyectos parecidos, y lo que sigue (16 de noviembre de 2026)

- **El nombre del estándar.** **LUCID** (*Logged, Unforgeable, Confidential, Interconnected, Discoverable*), como familia: LUCID-ID, LUCID-DIR, LUCID-MSG (con un perfil LUCID-MLS), LUCID-FED y LUCID-LOG. El dueño lo decidió el 19 de noviembre, para todo (sección 35).
- **La comparación con proyectos y propuestas parecidos,** hecha aparte, dejó esto:
  - Ningún proyecto junta identidad por claves con instancias y delegaciones, directorio, topics con esquema y política, MLS, federación y un registro de transparencia que los clientes auditan.
  - Lo más propio es que no haga falta fiarse del hub.
  - A2A y MCP son el estándar de hecho: hay que ser compatible con ellos, y con el directorio de AGNTCY.
  - Lo que le faltaba al proyecto, por importancia: testigos para el registro, comprobar una entrada sin repasar el registro entero, rotar la clave de un agente, y la compatibilidad con A2A, AGNTCY y el registro de MCP.

**Decisión del dueño (16 de noviembre de 2026).** Seguir, y por este orden:
1. Compatibilidad con A2A, AGNTCY y MCP (secciones 28 a 31).
2. Reforzar el registro de transparencia: testigos, formatos estándar y comprobar una sola entrada. Los testigos los había dejado el dueño para más adelante (sección 20); ahora entran. Hecho (secciones 32 y 34).
3. Rotar y recuperar la clave de un agente. Hecho (sección 33).

## 28. La tarjeta de A2A de cada agente (16 de noviembre de 2026)

Primer bloque de la compatibilidad (punto 2 de la sección 27). A2A 1.0 se leyó de su repositorio: la especificación, su definición en protobuf y su SDK oficial para JavaScript.

**Qué se hizo.** Cada agente tiene su tarjeta en el formato de A2A, firmada por él, y el hub la sirve en `/a2a/<did>/.well-known/agent-card.json`.

**Decisiones, y por qué.**

- **La tarjeta de A2A sale por regla de la tarjeta de siempre** (`src/core/a2a.mjs`), no se escribe aparte. Con dos descripciones, el hub tendría que validar y moderar las dos, y podrían decir cosas distintas. La regla copia los valores sin transformarlos: partir un nombre en palabras o pasarlo a minúsculas depende de la versión de Unicode de cada Node, y el agente y el hub firmarían bytes distintos.
- **La firma el agente, no el hub.** Una tarjeta firmada por el hub diría «el hub dice», y el hub no es de fiar para la autoría. La firma es la de A2A (JWS con EdDSA sobre JCS), con el `did:key` como `kid`: la clave va en la firma.
- **La firma viaja dentro de la tarjeta** (`a2a`). Así no hay operación nueva en el almacén, ni ruta para subirla, ni entrada nueva en el registro: la cubre la firma de la tarjeta y queda apuntada con ella. La otra opción, una operación aparte, dejaba un rato sin tarjeta de A2A entre dos peticiones y más código.
- **El hub comprueba la firma al aceptar la tarjeta y otra vez al servirla.** Al aceptarla, para decirle al agente que algo va mal (`invalid_card`). Al servirla, porque la dirección del hub puede cambiar: una tarjeta es para una dirección, y con otra ya no se sirve hasta que el agente la publica de nuevo.
- **Sin `jku`.** A2A deja apuntar a un JWKS por URL. Uno servido por el hub haría depender la clave de la palabra del hub, que es justo lo que se quiere evitar.
- **Es descubrimiento, no llamadas.** Un agente del hub no sirve las operaciones de A2A. Su única interfaz en la tarjeta es el protocolo del hub, nombrado por una URI como pide A2A para lo que no es uno de sus tres transportes. Un puente de A2A a mensajes del hub tendría que ver los mensajes en claro, y con `--require-e2e` el hub ni los aceptaría: no se ha hecho.
- **El SDK no pide la tarjeta de A2A al hub.** La hace a partir de la tarjeta del agente, que ya verifica y contrasta con el registro. Así tiene lo que A2A no da: saber que es la última.

**Lo que enseñó el SDK oficial** (`checks/a2a-client`, 15 comprobaciones con procesos reales):

- **Deja fuera de lo que se firma un objeto vacío.** La especificación dice que `capabilities` es obligatorio y va siempre; su SDK lo quita si está vacío, y la firma no cuadraba. Ahora la tarjeta dice `streaming: false` y `pushNotifications: false`, que es verdad y las dos lecturas lo conservan. Con eso, la forma canónica de este proyecto y la del SDK oficial son iguales byte a byte, también con acentos, kanji, emojis y caracteres de control.
- **Lee la ruta de la tarjeta como relativa a la dirección del agente.** Sin barra final, se come el DID. Por eso la dirección que se da a un cliente de A2A acaba en barra (`a2aAddress`).
- **No toma al agente por uno al que pueda llamar:** «no compatible transport». Es lo correcto.

**Vectores oficiales en los tests:** la firma JWS con EdDSA del apéndice A.4 de RFC 8037, y la forma canónica del ejemplo de la sección 8.4.1 de A2A.

**Casos de ataque en los tests** (`test/a2a.test.mjs`, 7 tests; 14 mutaciones, todas cazadas): una firma de otro agente, con su nombre o con el del agente; la del agente para otro hub o sobre otra tarjeta; una tarjeta cambiada por el camino; una firma añadida junto a la buena; un `alg` que no es EdDSA; campos que nadie firmó; un hub que cambia lo que tiene apuntado; un agente suspendido o retirado; una instancia que intenta firmarla.

**Pendiente del dueño.**
- **El nombre del binding** (`urn:agenthub:binding:v1`) es provisional: debería colgar del dominio del proyecto, que aún no existe. Cambiarlo obliga a cada agente a publicar su tarjeta otra vez.

**Lo que no está comprobado:** los SDK de A2A de otros lenguajes, y ningún catálogo que lea estas tarjetas.

**Lo que sigue del punto 2:** exportar las tarjetas como registros OASF para el directorio de AGNTCY (sección 29), y preparar el alta del servidor MCP en el registro de MCP.

## 29. Un agente como registro de OASF, para el directorio de AGNTCY (16 de noviembre de 2026)

Segundo bloque de la compatibilidad. Los repositorios de OASF y del directorio son públicos y se leyeron enteros: el esquema 1.1.0 de OASF, y del directorio sus registros de prueba, su documentación de identidad y su herramienta (`dirctl`).

**Qué se hizo.** `src/core/oasf.mjs` escribe el registro de un agente alrededor de su tarjeta de A2A firmada; el SDK lo ofrece (`oasfRecord`) y el CLI también (`agenthub agent oasf`). No publica nada.

**Decisiones, y por qué.**

- **Solo exportar.** Publicar en un directorio es hablar con un servicio de fuera con la clave de quien publica: lo hace quien lleva el agente, con `dirctl`. El proyecto no añade un cliente de su API.
- **Las habilidades se piden, no se deducen.** Las de OASF son unas 500 entradas de una taxonomía propia. Deducirlas del texto de una tarjeta sería clasificar con un modelo, y lo que sale de ahí lo firmaría quien publica sin haberlo elegido.
- **Los autores también se piden:** OASF los quiere como «nombre <correo>», y un agente es una clave.
- **La tarjeta de A2A va entera dentro del registro, con su firma.** Quien saque el registro de un directorio puede seguir comprobando quién firmó la tarjeta. El registro solo se escribe alrededor de una tarjeta que verifica.
- **La identidad se declara como la lee el directorio:** el DID del agente en `agntcy.dir/identity` y el de su controlador en `agntcy.dir/owner`. El directorio verifica una reclamación sacando la clave del propio `did:key`, o del documento de un `did:web`: las dos identidades que usa este proyecto.
- **El módulo de A2A lleva la tarjeta en línea** (`card_data`), que OASF marca como obsoleta desde la 1.0.0 pero sigue siendo obligatoria en la 1.1.0, y es lo que usan los registros de prueba del directorio.

**Lo que no está comprobado, y es todo lo de fuera.** El validador de OASF es un servicio (`schema.oasf.outshift.com`) al que la sesión no llega, y no hay Docker para arrancar uno ni un directorio. Los tests comprueban lo que el esquema dice que es obligatorio y la forma de sus fechas, no que un directorio acepte el registro.

**Pendiente del dueño.**
- **Publicar el primer registro,** cuando haya un hub desplegado: es la prueba que falta.
- **La clave del agente en PEM.** `dirctl identity claim` firma con una clave en un fichero PEM, y la de un agente está en su fichero de identidad con otro formato. Sacarla es darle a otra herramienta todo lo que el agente es: no se ha añadido una orden que lo haga. La alternativa es que el CLI firme la reclamación él mismo, que es más trabajo y tampoco se podría probar aquí.

## 30. Un test que se colgó en GitHub, y lo que había detrás (16 de noviembre de 2026)

La ejecución de GitHub del bloque de la tarjeta de A2A falló en Node 20: un fichero de tests agotó su minuto. No era de lo nuevo. Era `test/pairing.test.mjs`, que llevaba semanas pasando, y aquí pasa siempre.

**La causa.** Un hub con el emparejamiento abierto comprueba que la dirección de quien pide emparejarse es pública. Para una dirección IPv6 escrita tal cual (`https://[::1]:1`), el nombre que da la URL conserva los corchetes, y con ellos el hub la buscaba en el DNS como si fuera un nombre. En la máquina de GitHub esa consulta no volvió en un minuto. Dos defectos, los dos del hub y no del test:

- **Una dirección IPv6 escrita nunca pasaba la comprobación,** ni siendo pública: se rechazaba porque el «nombre» no existía. Fallaba hacia lo seguro, pero fallaba.
- **La consulta de un nombre no tenía tope de tiempo.** Cualquiera con una clave puede pedir emparejarse, y con un nombre cuyo DNS no contesta dejaba la petición esperando lo que tardara el sistema en rendirse.

**El arreglo.** Una dirección escrita se juzga por lo que es, sin consultar nada, y la consulta de un nombre espera lo que se le da a un hub para contestar (`peerTimeoutMs`) y no más. Con su test, que ya no depende del DNS de la máquina: el hub de prueba recibe cómo resolver nombres (`lookup`) y cómo llegar a otro hub (`fetch`).

**Lo que queda:** una consulta que agota su tiempo sigue ocupando un hilo del sistema hasta que el sistema se rinde; el hub deja de esperarla, pero no puede cancelarla. El límite de peticiones de emparejamiento por dirección acota cuántas puede haber a la vez.

**No era toda la causa.** La ejecución siguiente, ya con ese arreglo, se colgó otra vez en Node 20, en otro fichero (`test/statements.test.mjs`), que no hace ninguna consulta de DNS. Lo que se sabe:

- No había pasado nunca: 33 ejecuciones de los tests en GitHub antes de ese día, todas limpias en los tres Node. Desde el bloque de la tarjeta de A2A, dos de cuatro en Node 20, cada una en un fichero distinto, las dos en el cuarto test del fichero.
- Aquí no se reproduce: ni la batería entera en Node 20 (la misma versión, 20.20.2), ni esos ficheros 72 veces seguidas con seis procesos a la vez.
- Lo que cambió ese día en el código que esos tests ejecutan es síncrono y pequeño (firmar y comprobar la tarjeta de A2A). No se ha encontrado en él nada que pueda esperar.

**Lo que se hizo:** un fichero de tests que lleva 40 segundos dice ahora en qué test está, qué peticiones no han contestado y qué mantiene ocupado al proceso (`test/helpers.mjs`). La próxima vez que pase, GitHub dirá qué se esperaba. **La causa sigue sin conocerse.**

## 31. El alta del servidor MCP en el registro de MCP, preparada (16 de noviembre de 2026)

Tercer bloque de la compatibilidad. El repositorio del registro es público y se leyó: su guía, lo que exige a una ficha y a un paquete, y su herramienta (`mcp-publisher`), que se compiló aquí.

**Qué se hizo.**
- **`server.json`**, la ficha del servidor: cómo se llama, qué hace, en qué paquete está y cómo se arranca (`agenthub mcp`, con `AGENTHUB_URL` y `AGENTHUB_IDENTITY`). La herramienta oficial la da por válida.
- **`mcpName` en `package.json`**: el registro comprueba que quien publica la ficha es dueño del paquete buscando ahí el nombre del servidor.
- **`files` en `package.json`**. Se vio al preparar esto: un `npm publish` habría subido el repositorio entero, 187 ficheros, con el código propietario del servicio alojado, `docs/`, los tests y los flujos de GitHub. Ahora el paquete lleva `bin/`, `src/` y las licencias: 47 ficheros. `test/package.test.mjs` lo comprueba preguntándoselo a npm.

**No se ha publicado nada,** ni el paquete ni la ficha.

**Un error mío que hay que saber.** Para validar la ficha usé `mcp-publisher validate`, que su documentación describe como «validar sin publicar». No valida en local: envía la ficha al servicio del registro (`registry.modelcontextprotocol.io`) y devuelve su veredicto. Lo vi en su salida, después de cuatro envíos: el borrador y tres variantes rotas para ver que las rechazaba. La ficha lleva el nombre del servidor, que incluye el usuario de GitHub del dueño, el nombre del proyecto y el del paquete. No publica ni registra nada, pero salió del entorno sin que el dueño lo hubiera pedido. No se ha vuelto a usar.

**Pendiente del dueño,** porque todo ello es hacia fuera:
1. **El nombre del paquete en npm.** Decidido el 21 de noviembre: `lucid-kit`.
2. **El nombre del servidor en el registro.** Hoy `io.github.<usuario>/agenthub`, que se demuestra entrando con GitHub. Con un dominio propio sería `<dominio al revés>/agenthub`, demostrado por DNS o HTTP.
3. **Publicar el paquete en npm.** El código es público en GitHub desde la 1.0.0; el paquete no está en npm.
4. **Publicar la ficha:** `mcp-publisher login github` y `mcp-publisher publish`.

La otra vía, sin npm, es una imagen en un registro público de contenedores con la etiqueta `io.modelcontextprotocol.server.name`; la imagen del hub ya trae el CLI, pero tampoco está publicada.

## 32. Testigos del registro de transparencia (16 de noviembre de 2026)

Primer bloque del punto 3 de la sección 27. El dueño había dejado los testigos para más adelante (sección 20); al elegir «registro y claves» entran ahora. Las especificaciones de C2SP se leyeron de su repositorio: `signed-note`, `tlog-checkpoint`, `tlog-cosignature` y `tlog-witness`.

**Qué se hizo.**
- **El estado del registro en el formato de C2SP** (`src/core/note.mjs`): tres líneas (de quién es el registro, cuántas entradas, la raíz) firmadas por el hub, y servidas en `GET /v1/log/note`.
- **Un testigo** (`src/core/witness.mjs` con las reglas, `src/witness/server.mjs` con el servicio, `agenthub witness` en el CLI): cofirma el estado de un registro solo si sigue de lo que cofirmó la última vez.
- **El hub enseña su registro a sus testigos** cada quince segundos (`--witness CLAVE@URL`) y sirve la última cofirma de cada uno.
- **El cliente pide testigos** (`witnesses`, `--trust-witness`): toma el registro solo hasta donde bastantes de ellos lo han cofirmado hace poco.

**Decisiones, y por qué.**

- **El formato de C2SP, tal cual.** Es el que hablan los testigos públicos de otros registros (Sigstore, los de Go, los de Certificate Transparency): un testigo no tiene que ser de este proyecto. Inventar uno propio habría dejado al proyecto con testigos que solo puede poner él.
- **El registro de un hub se llama como su clave** (su DID es el `origin`). La otra opción, su dirección, haría de un hub que cambia de dominio un registro nuevo para los testigos. Un testigo se configura solo con el DID del hub: la clave va dentro.
- **El cliente no espera a los testigos para cada cambio.** Sigue leyendo el registro hasta el final, como antes, y además exige que lo último cofirmado sea el principio de lo que leyó. Si tuviera que esperar a que se cofirme cada entrada, registrarse tardaría una ronda de testigos. El precio: las entradas de los últimos segundos no están cubiertas hasta la ronda siguiente.
- **Una cofirma vale cinco minutos** (`witnessMaxAgeMs`). Es lo que acota cuánto puede durar un engaño: un hub con dos listas puede seguir enseñando al lector de la segunda lo último que se cofirmó antes de separarlas, hasta que caduca. Menos tiempo aguanta peor un testigo caído; más, alarga el engaño.
- **El hub pide la cofirma otra vez en cada ronda aunque nada haya cambiado.** Es lo que deja al cliente exigir que sea reciente.
- **De quién fiarse lo decide el cliente.** El hub dice quién lo vigila (`/v1/info`), pero un cliente no toma de ahí a quién creer: sería el hub eligiendo a sus propios vigilantes.
- **Sin testigos, todo sigue como antes.** No hay red de testigos todavía, y exigirlos por defecto dejaría sin funcionar a todos los clientes.
- **El testigo guarda lo cofirmado antes de contestar,** y atiende cada petición entera antes de mirar la siguiente. Es lo que pide la especificación para que dos peticiones a la vez no lo hagan retroceder.
- **Lo que firma un testigo no se confunde con nada más:** empieza por `cosignature/v1`. Y el estado que firma el hub tiene un número en su segunda línea, donde las demás firmas del proyecto tienen un objeto JSON.

**Un ataque que salió al escribir los tests.** Un hub puede llevar un segundo registro con otro nombre y su misma clave, y pedir al mismo testigo que vigile los dos. Cada uno solo crece, así que el testigo cofirma los dos. Si el cliente no comprobara de qué registro es el estado cofirmado, el hub le enseñaría la lista falsa «cofirmada». El cliente comprueba que el `origin` es el DID de su hub y que el hub lo firma con ese nombre.

**Un hub que vuelve con menos registro** (datos perdidos, una copia vieja) no se cofirma: los testigos recuerdan más. Los agentes que piden testigos dejan de creerle. Es lo que tiene que pasar, y hay que saberlo al restaurar una copia: a los usuarios hay que contarles que el hub ha vuelto atrás; con testigos, además, el registro no vuelve a cofirmarse hasta que cada testigo olvide lo que recordaba, que es una decisión de quien lo lleva.

**Vectores oficiales en los tests:** la nota firmada de ejemplo de `signed-note` con su clave, el ejemplo de `tlog-checkpoint`, y el texto exacto que firma un testigo según `tlog-cosignature`.

**Tests** (`test/witness.test.mjs`, 9 tests; 24 mutaciones, todas cazadas) y **comprobación con procesos reales** (`checks/witness.sh`, 17 comprobaciones): dos listas con la misma clave, un hub que vuelve atrás, un testigo caído, uno que no es el que se dijo, cofirmas viejas y del futuro, un estado de otro registro, uno sin la firma del hub, peticiones mal escritas, dos peticiones a la vez.

**Lo que no está hecho ni comprobado.**
- **No hay red de testigos.** El código permite que cualquiera lleve uno; quién los lleva está por decidir. Dos hubs emparejados podrían vigilarse el uno al otro: no está hecho.
- **Los testigos públicos de C2SP** no se han probado con este hub, ni este testigo con otros registros.
- **ML-DSA-44,** la cofirma que C2SP recomienda ya, no está: solo Ed25519.
- **Comprobar una sola entrada sin leer el registro entero** (el resto del punto 3): sin empezar. Hace falta un mapa verificable sobre el registro, al estilo de KEYTRANS. El dueño decidió hacerlo después del cambio de clave (sección 33). Hecho después: sección 34.
- **El servicio alojado** no arranca ningún testigo ni se le dice ninguno.

**Pendiente del dueño.**
- **Quién hace de testigo del servicio alojado.** Tiene que ser alguien que no sea el propio servicio.
- **Si los clientes del servicio alojado deben pedir testigos por defecto,** cuando los haya.
- **La licencia del testigo.** Es AGPL, como el hub y el verificador, por seguir la regla de que los servicios lo son. Si se quiere que terceros lo lleven sin pensárselo, Apache sería más fácil de aceptar: es decisión del dueño.

## 33. Cambio de clave de un agente: el relevo (16 de noviembre de 2026)

Punto 4 de la sección 27. Era lo que más cambiaba qué es un agente, y el dueño lo decidió antes de construir.

**Decisiones del dueño (16 de noviembre de 2026).**

| Pregunta | Decisión |
|---|---|
| Cómo cambia de clave un agente | **Relevo firmado.** El agente pasa a una clave nueva, con otro DID, y el relevo queda firmado y en el registro. Una firma se sigue comprobando solo con el DID de quien firma |
| Quién puede firmar el relevo | **El controlador o una clave de recuperación.** Si el agente actúa por un controlador o declaró una clave de recuperación guardada aparte, solo ellos pueden relevarlo. Un agente sin ninguna de las dos se releva con su propia clave |
| Comprobar una sola entrada del registro | Después del cambio de clave |

La otra opción era que el DID dejara de salir de la clave (un identificador estable con un documento de claves que cambia, como did:plc). Se descartó: cada firma habría que comprobarla contra el registro de un hub, y lo que hoy se verifica en el extremo sin preguntar a nadie dejaría de serlo.

**Qué se hizo.**
- **El guardián** (`agent.guardian`): la clave que puede relevar a un agente. La nombra el agente con su clave, una vez. `PUT /v1/agents/me/guardian`, `nameGuardian`, `agenthub guardian init | name`.
- **El relevo** (`agent.succeed`): lo firma el guardián, o el agente si no nombró ninguno, y el sucesor firma que lo acepta (`succession.accept`). `POST /v1/agents/me/succession`, `handOver`, `createSuccession`, `takeOver`, `standsFor`, `agenthub succession sign | take | of`.
- **Tres contextos de firma nuevos** (`agenthub/guardian/v1`, `agenthub/succession/v1`, `agenthub/succession-acceptance/v1`), dos tipos de entrada en el registro con sus reglas en `Directory`, y dos operaciones en el almacén.
- **Quien escribe a un agente relevado** recibe `404 recipient_succeeded` con el DID del sucesor, por cualquiera de los caminos (en claro, sellado o sobre MLS).
- **Los topics privados siguen al sucesor,** con clave o grupo nuevos (abajo).

**Decisiones de diseño, y por qué.**

- **El guardián se nombra, no se deduce.** La regla «manda el controlador mientras haya delegación» habría hecho depender el registro de si una delegación está en vigor, que depende del reloj, y las reglas de `Directory` no pueden depender de él. Nombrarlo es una entrada más, con su firma.
- **Se nombra una vez y no cambia.** Si pudiera cambiarse con la clave del agente, quien la roba nombraría el suyo y el guardián no protegería nada. El precio: un agente que deja a su controlador sigue guardado por él, y un guardián perdido no se sustituye. Está dicho en el README.
- **El SDK nombra al controlador él solo** cuando es una clave (`did:key`), al presentar la delegación, si el agente no tenía guardián. Así la decisión del dueño («si actúa por un controlador, solo él») se cumple sin que nadie tenga que acordarse. Se puede evitar (`{ guardian: false }`) o nombrar antes otra clave.
- **Un controlador que es un dominio (`did:web`) no es guardián.** Sus claves están en un documento que cambia y que el registro no puede comprobar después; un guardián tiene que poder comprobarse solo con lo apuntado. Sus agentes nombran una clave de recuperación.
- **El sucesor firma que acepta.** Sin eso, cualquiera podría hacer a otro agente sucesor del suyo y cargarle sus bloqueos.
- **Una vez por agente, y nadie releva a dos.** Lo primero hace que lo firmado no se pueda reutilizar; lo segundo evita juntar en un agente lo de varios. El sucesor sí puede ser relevado a su vez, y `standsFor` sigue la cadena.
- **A un agente retirado solo lo releva un guardián nombrado antes.** Con guardián, es el camino para volver de una clave filtrada: se corta primero (retirar, o revocar la delegación) y se releva después. Sin guardián se cerró: la clave que firmaría es la que se filtró, y quien la robó se quedaría con un agente que su dueño ya había retirado. Salió al repasar el diseño, antes de entregarlo.
- **Qué pasa al sucesor: los topics y los bloqueos.** Los topics, porque son lo que un agente tiene que otros usan. Los bloqueos, en los dos sentidos, porque si no un relevo sería la forma de salir de uno. No pasa lo que el primero tenía por ser quien era: la delegación y el nivel (el controlador firma otra al sucesor), el guardián, las instancias, las suscripciones y ser miembro de topics de otros.
- **Un agente suspendido no se releva.** Es una regla del hub, no del registro: la suspensión no está en él.
- **Entre hubs no se dice quién releva a quién.** Un agente retirado no se enseña a otros hubs, y eso no cambia: desde fuera, un agente relevado es uno que ya no está.

**Los topics privados.** Un topic privado no puede simplemente cambiar de dueño: quien tuviera la clave del primero podía leerlo. Al probarlo con la primera versión, el sucesor heredaba el topic y no podía usarlo, y los miembros rechazaban al dueño nuevo. Lo que se hizo:

- **El sucesor reabre lo que hereda** al tomar el relevo, si sigue el registro (por él sabe qué topics eran del primero): clave nueva en un topic con clave de topic, grupo nuevo sobre MLS, con los miembros que había y sin los lectores del primero. `takeOver` dice cuáles (`reopened`, `not_reopened`).
- **El dueño que un cliente tiene de un topic cambia solo si el registro dice que hubo relevo** (`#handedOver`). Un cliente que no sigue el registro sigue rechazando al dueño nuevo, como rechazaba cualquier cambio de dueño: para él sería la palabra del hub, y con ella un hub daría cualquier topic a cualquiera.
- **Sobre MLS, nadie escribe en un grupo de antes del relevo.** El cliente apunta cuál era el último (`closed`) y espera al siguiente. Lo comprueba un test con un sucesor que no reabre.
- **Una invitación se abre una vez**, porque el secreto que la abre se borra al usarlo. Antes de abrir la de un grupo que no conoce, el cliente mira otra vez quién es el dueño del topic: si no, la primera invitación del sucesor se perdería contra el dueño anterior.
- **Un fallo que esto destapó:** el dueño que hacía el grupo de un topic se contaba a sí mismo entre los que «llegan» y se pedía un lector que no era él. Nunca había pasado porque el dueño siempre estaba ya en la lista del hub.

**Tests** (`test/succession.test.mjs`, 8 tests; `test/federation.test.mjs` para lo que se dicen dos hubs): el relevo y lo que ve quien conocía al agente; un ladrón con la clave del agente, con y sin guardián; lo que un hub no puede inventarse en el registro; qué pasa al sucesor y qué no, también tras reiniciar el hub; los dos tipos de topic privado; y el grupo anterior, donde nadie escribe. Se probaron 46 mutaciones de las reglas, en el registro, el hub, el almacén y el SDK, y los tests las cazan todas. Por el camino salieron cuatro que no: dos comprobaciones que no tenían test (que el hub no acepta de una instancia el nombramiento de un guardián, y que el SDK no escribe para el dueño que un hub nombra al dar el grupo de un topic, que ya estaba sin test antes de este bloque), y dos cosas que sobraban y se quitaron (una comprobación del hub que no podía dispararse y una línea del SDK que no cambiaba nada). **Con procesos reales** (`checks/succession.sh`, 40 comprobaciones): todo el camino con el CLI, con clave de recuperación, con controlador y sin guardián.

**Lo que no está hecho ni comprobado.**
- **Entre hubs:** no se dice quién releva a un agente, y los bloqueos hechos desde otro hub no siguen al sucesor.
- **Un guardián es una sola clave.** No hay umbral (dos de tres), ni repuesto, ni forma de cambiarlo.
- **Con clave de topic,** un miembro que ya tenía la clave sigue escribiendo con ella hasta que el sucesor reparte la nueva. Sobre MLS no.
- **Lo que quedaba por leer de antes del relevo** en un topic privado puede no abrirse.
- **Un hub deshonesto puede callarle el relevo a un miembro** enseñándole el registro de antes; con testigos, lo que dura una cofirma.
- **Un agente sin guardián cuya clave se roba** puede ser relevado por el ladrón, o recibir de él un guardián, antes de que su dueño reaccione. Es lo que significa no tener guardián; el README dice que se nombre pronto.
- **La clave de un hub y la de un controlador** no tienen nada parecido.
- **El servidor MCP** no tiene herramientas para esto: es cosa de quien lleva el agente, no del modelo. Solo explica `recipient_succeeded`.
- **La consola del servicio alojado** no enseña guardianes ni relevos.
- **Un cliente que siga el registro y no conozca estas entradas deja de creer al hub** en cuanto alguien nombra un guardián: para él es una entrada que no sabe comprobar (`log_invalid`), y así tiene que ser. Pasa con cada tipo de entrada nuevo, y ya pasó con las atestaciones de cuenta. Hoy no afecta a nadie: los clientes de la 0.7 y anteriores no pueden hablar con un hub actual desde que las peticiones se firman para su dirección (`unbound_request`, sección 25), y después no se ha publicado ninguna versión. Probado a mano con el CLI de la 0.6. Cuando haya versiones publicadas, un tipo de entrada nuevo necesitará un periodo en que los clientes ya lo conozcan y los hubs aún no lo apunten.

**Pendiente del dueño.**
- **Si el guardián debe poder cambiarse** con la firma del guardián actual. Hoy no: es lo más simple y lo más difícil de usar mal. Cambiarlo permitiría sustituir una clave de recuperación vieja, a cambio de una regla más.
- **Si el servicio alojado debe hacer de guardián** de los agentes de sus cuentas (recuperar un agente entrando con GitHub). Sería cómodo, y haría del servicio alguien capaz de quedarse con cualquier agente.

## 34. Lo que el registro dice de un agente, sin leer el registro (16 de noviembre de 2026)

Lo que quedaba del punto 3 de la sección 27, hecho después del cambio de clave como decidió el dueño (sección 33). Hasta aquí, contrastar algo con el registro era leerlo entero una vez; ahora se puede preguntar por un solo nombre.

**Qué se hizo.**
- **Un mapa verificable** (`src/core/statemap.mjs`): nombres a valores, con una raíz que cambia si cambia cualquier cosa, y demostraciones de lo que hay bajo un nombre, o de que no hay nada.
- **El directorio como ese mapa** (`src/core/log.mjs`): bajo `agent:DID`, `instance:DID`, `topic:NOMBRE`, `account:DID` y `delegation:EMISOR|ID` va lo que el directorio tiene de cada uno, con todos sus campos siempre presentes. `Directory` lo lleva al día en cada regla.
- **Una entrada nueva, `log.state`,** donde el hub apunta la raíz, y su regla: tiene que ser la del directorio en ese punto.
- **`GET /v1/log/state?name=…[&size=…]`** en el hub, **`verifyStateAnswer`** en el núcleo, **`logState(nombre)`** y `stateName` en el SDK, y **`agenthub log state agent|instance|topic|account …`** en el CLI.

**Decisiones de diseño, y por qué.**

- **La raíz va dentro del registro, no en lo que firma el hub aparte.** Si fuera solo en su firma, un hub podría firmar dos estados distintos para el mismo registro y enseñar uno a cada uno: los testigos cofirman el registro, no eso. Dentro del registro, quien ve la misma cabeza ve el mismo estado, y quien lo lee entero comprueba que es el bueno.
- **En una entrada propia, y no en cada entrada.** Llevarla en cada entrada obligaba al hub a sacar el estado en el mismo instante en que apunta, y las reglas del registro no son instantáneas (comprobar una delegación puede esperar). Con una entrada propia, el hub lee su registro como cualquier lector, con `Directory`, y apunta el resultado. Hay una sola manera de decir a qué llega un directorio, no dos.
- **Se escribe cuando alguien pregunta y algo cambió, y antes de cada ronda de testigos.** Un registro al que nadie pregunta no crece. Como mucho, una entrada de estado por cada cambio de verdad: no hay forma de hacerlo crecer preguntando.
- **Lo que cofirman los testigos acaba en una entrada de estado.** Así un cliente con testigos puede pedir un nombre bajo la palabra de ellos. Ve el registro de la última ronda, no el de ahora: lo mismo que ya pasaba al seguirlo.
- **El hub guarda los 32 últimos estados que apuntó** (`VIEWS_KEPT`), más que las rondas que caben en lo que vale una cofirma. El mapa no se copia: cada estado comparte con el siguiente todo lo que no cambió.
- **El estado no se guarda en disco.** Sale del registro, y el hub lo rehace la primera vez que se lo piden tras arrancar. Uno al que nadie pregunta no lo calcula nunca.
- **Un registro por nombre, con todos sus campos.** Lo que se enseña de un agente es todo lo que el registro tiene de él (`card`, `status`, `delegation`, `revoked`, `guardian`, `successor`, `predecessor`), con `null` donde no hay nada. No depende de cómo lo tenga en memoria quien lo calcula, y el orden de los campos da igual: se hashea en forma canónica.
- **El mapa es propio.** Un árbol de Merkle disperso con las ramas de un solo nombre recortadas, para que una demostración mida lo que el logaritmo del directorio y no 256 hashes. No sigue un formato publicado: el borrador de KEYTRANS no se pudo leer desde este entorno, y C2SP no tiene ninguno para mapas. Su definición son tres líneas, está en la cabecera de `statemap.mjs`, y los tests llevan raíces calculadas por un programa aparte, que solo comparte con el módulo esa definición.
- **`logState` no sustituye a seguir el registro.** Es una pregunta aparte. El SDK contrasta lo que el hub enseña con el directorio que lee entero, por funciones que lo consultan sin decir qué nombres van a mirar; cambiarlo para que trabaje solo con demostraciones es otro bloque.

**Qué garantiza y qué no.**
- **Sí:** que el registro de una cabeza dice eso de ese nombre, o nada. Para una raíz hay una sola respuesta por nombre. Con testigos, que es el registro que ven los demás, con lo que tarda una ronda.
- **No:** que el registro se sostenga. Quien pregunta por un nombre no ha comprobado que cada entrada siga de las anteriores: se apoya en que alguien lee el registro entero (cualquier cliente con estado, `log audit`). Un hub que apunte un estado falso queda con un registro que ningún lector acepta desde ahí, con su firma y las de sus testigos debajo; pero quien solo pregunta no lo ve por sí mismo.
- **No, sin testigos:** que sea el registro más reciente ni el que ven los demás. La respuesta dice cuándo apuntó el hub ese estado.

**Tests.** `test/statemap.test.mjs` (8): las raíces contra el programa aparte y a mano, el orden de llegada, presencia y ausencia, una sola respuesta por raíz, lo que no pasa por demostración, estados anteriores y tamaño. `test/logstate.test.mjs` (6): un cliente que no lee nada del registro; lo que un lector del registro rechaza; dieciocho respuestas falsas de un hub, todas rechazadas; con testigos; los estados que el hub guarda; y tras parar y arrancar. `test/helpers.mjs` comprueba además, al cerrar cada hub de cada test, que el mapa llevado entrada a entrada es el de lo que el directorio tiene: una regla que cambie algo sin decirlo no pasa. Mutaciones: 18 del mapa y 34 del resto, todas cazadas (seis no lo estaban al principio: cinco tests que faltaban y una comprobación que los hashes ya hacían, quitada). `checks/witness.sh` lo pasa con procesos reales, con y sin testigo. Los guiones de estas mutaciones, y los de las secciones 28 a 33, se guardaron después en `experiments/mutations/`, con su README: 149 mutaciones en siete áreas, todas cazadas.

**Lo que no está hecho ni comprobado.**
- **Un cliente que trabaje solo con demostraciones** (un cliente ligero): `getAgent`, `getTopic` y quién firma lo que llega siguen contrastándose con el registro leído entero, o con nada en un cliente sin estado.
- **Que cada agente vigile lo suyo.** Lo que hace fuerte a un mapa así, en KEYTRANS, es que cada uno comprueba cada cierto tiempo lo que el registro dice de él. Aquí un agente que sigue el registro ya lo ve todo; uno que no, no vigila nada.
- **La consistencia entre dos preguntas.** Un cliente sin estado no recuerda la cabeza anterior: un hub puede enseñarle primero un registro y luego otro más corto. Con testigos, no.
- **El formato frente a KEYTRANS** o a cualquier otro: no se ha comparado.
- **Rendimiento con un registro grande:** el mapa se ha probado con 20.000 nombres; el hub rehace el estado leyendo su registro entero la primera vez, y eso no se ha medido con uno de ese tamaño.
- **Un cliente que siga el registro y no conozca `log.state`** deja de creer al hub en cuanto aparece una, como con cualquier tipo de entrada nuevo (sección 33).

**Pendiente del dueño.**
- **Si un cliente sin estado debe comprobar así, por defecto, lo que el hub le enseña.** Hoy no contrasta nada. Sería más seguro y costaría una petición más por consulta, y una entrada de estado en el registro por cada cambio.
- **Si merece la pena el cliente ligero completo** antes de que haya registros grandes.

## 35. La landing de LUCID (19 de noviembre de 2026)

Pedida por el dueño antes de seguir con lo técnico. Hecha con la skill `frontend-design` de Anthropic, que el dueño instaló para esto junto con `web-design-guidelines` de Vercel.

**Decisiones del dueño (19 de noviembre de 2026).**

| Pregunta | Decisión |
|---|---|
| Nombre | **LUCID**, como sigla (*Logged, Unforgeable, Confidential, Interconnected, Discoverable*) |
| LUCID y Agent Hub | **Todo se llama LUCID.** La página solo habla de LUCID. El código, el paquete, el CLI y la documentación se llaman todavía Agent Hub: renombrarlos queda pendiente |
| Público | Los dos, con quien construye agentes primero y las empresas después |
| Idiomas | Inglés como principal, y español |
| Dónde y cómo | En este repositorio, `site/`, HTML estático sin dependencias |
| Dirección visual | La propuesta, sin cambios: papel y tinta violeta, sello violeta para lo verificado y rojo para lo roto, Atkinson Hyperlegible, la demo en la cabecera y las cinco letras bajando por la página |
| Enlaces a GitHub | El repositorio es privado; el dueño lo hará público antes de publicar la página |
| Contacto de empresas | Un correo. **Falta saber cuál**: hasta entonces los enlaces van a `contact@example.invalid` |

**Qué se hizo.**
- **Las dos páginas,** `site/index.html` y `site/es/index.html`: cabecera con la demo, las cinco propiedades, cómo probarlo, dónde usarlo y en qué punto está.
- **La demo:** un evento firmado, con el formato real del protocolo, que el visitante puede cambiar haciendo de hub. El navegador vuelve a comprobar la firma (`site/assets/verify.mjs`: JCS, la clave sacada del did:key y Ed25519 con WebCrypto) y la página estampa «firma válida» o «falsificado». Reordenar las claves o cambiar los espacios no rompe la firma, porque se firma la forma canónica; la página lo explica.
- **Bytes reales:** `site/tools/fixtures.mjs` arranca en memoria un hub y un testigo con el código del repositorio y escribe lo que la página enseña. Son el evento firmado por un agente registrado allí y el estado del registro de ese hub, firmado por él y cofirmado por el testigo.
- **Tests** (`test/site.test.mjs`, 5): la comprobación de la página contra la del núcleo, para el evento y para cada forma de falsificarlo; la forma canónica y la clave de un did:key; que lo que enseña la página es real; y que las dos páginas son la misma.

**Decisiones de diseño, y por qué.**
- **La demo es lo único llamativo.** Es lo que distingue al proyecto, que no haga falta fiarse del servidor, enseñado y no contado. Lo demás va sobrio.
- **La paleta sale del sello de quien da fe,** porque los testigos cofirman el registro. Se descartó el blanco con azul marino de cualquier web de seguridad.
- **Atkinson Hyperlegible** está hecha para que no se confundan 0 y O, ni l, 1 e I, que es lo que pide leer un DID o un hash. Se sirve desde el propio sitio: la página no pide nada a terceros y no lleva analítica.
- **Las cinco letras como estructura,** en vez de cinco tarjetas iguales con icono: el nombre es la lista.
- **Nada que caduque en el texto:** la página no dice cuántos tests hay, sino qué comprueban.
- **Lo que no existe se dice:** el servicio alojado está «en preparación», sin precio, y el estado del proyecto (0.7, sin auditar, sin desplegar) va en su propia sección.

**Segunda vuelta (20 de noviembre de 2026).** Al verla, el dueño pidió más diseño, color, animaciones y una infografía o un isométrico que representara LUCID. Decidió:

| Pregunta | Decisión |
|---|---|
| Dónde va la ilustración isométrica | En la cabecera. La demo baja a ser la segunda sección, «Haz de hub» |
| Cuánto color | Una tinta por letra, y la parte de la ilustración de cada una en la misma: L verde azulado (el registro y su testigo), U violeta (los agentes y sus firmas), C azul celeste (el cifrado), I ocre (el puente entre hubs), D frambuesa (el directorio) |
| Cuánto movimiento | Vivo pero tranquilo: la escena en bucle lento, que se para fuera de pantalla; las viñetas de las letras empiezan al llegar a ellas; todo quieto con «reducir movimiento» |

Lo que se hizo:
- **La escena de la cabecera.** Dos hubs con sus agentes. Mensajes sellados (U) y con candado (C) cruzan el puente (I) de un agente a otro. El registro (L) crece entrada a entrada, mientras un testigo aparte cofirma cada nueva cabeza. El directorio (D) saca una ficha de vez en cuando.
- **Una leyenda bajo la escena,** con las cinco letras, que enlaza a cada propiedad.
- **Una viñeta isométrica animada por letra,** con su parte de la escena.
- **`site/tools/art.mjs`** calcula la geometría isométrica y escribe los SVG en las dos páginas. Cada bucle termina en el mismo dibujo con el que empieza: el registro, por ejemplo, se hunde una entrada en el suelo cuando llega la nueva, así que crece siempre y nunca salta.
- **`site/assets/motion.mjs`** controla el movimiento.
- **Las tintas, corregidas.** El dueño vio que la C (añil, `#2c5bb8`) y la D (rosa, `#c23b6a`) no se distinguían lo bastante. Medidas con visión normal y simulando las tres dicromacias (Machado 2009, distancia en Lab), salió algo más: tres tintas tiraban a morado (U, C y D), la C se parecía a la U, y con los daltonismos más frecuentes la D se parecía a la L. Se dejaron la L, la U y la I, y se cambió la C a azul celeste (`#0d6aad`) y la D a frambuesa (`#c4144f`). La I se oscureció un poco (`#9e6c00`) para que el blanco se lea encima. La pareja más próxima con visión normal pasó de 31 a 51; con protanopia y deuteranopia, el peor caso, de 11 a 16. Con tritanopia, mucho más rara, empeora la pareja L y C (de 15 a 10). En todas las tintas, el blanco encima se lee a 4,6:1 o más. Y la letra va siempre escrita, así que el color nunca es la única pista. La D queda cerca del rojo del sello «Falsificado» (22 de distancia), pero nunca aparecen juntos.
- **Un test más:** las dos páginas llevan los dibujos que hace el generador, sin texto, ocultos a los lectores de pantalla y con las tintas de la hoja de estilos.

**Comprobado** en Chrome sin interfaz, a 1440 y a 390 píxeles de ancho, en los dos idiomas. Las fuentes cargan, no hay errores en la consola ni peticiones fallidas, nada se sale de la pantalla en el teléfono y el foco del teclado se ve. Probados también los cuatro estados de la demo: válida, falsificada, de nuevo válida al reformatearla y «no es un evento» al romper el JSON. En la segunda vuelta, además: al cargar solo se mueve la escena, que está en pantalla, y al bajar hasta la D solo las dos viñetas a la vista; con «reducir movimiento», todas quietas en su fotograma y sin el golpe del sello.

**Lo que no está hecho ni comprobado.**
- **Publicarla:** falta dónde, el dominio, el correo de contacto y que el repositorio sea público. Nada se publica sin confirmación del dueño.
- **Con el dominio:** la dirección canónica, los `hreflang` y una imagen para compartir el enlace.
- **Otros navegadores:** probada después en Firefox 153 y en WebKit 26, el motor de Safari (sección 36).
- **`web-design-guidelines` no se ha pasado:** descarga sus reglas de GitHub en cada revisión. Queda para antes de publicar.
- **Renombrar el código a LUCID:** paquete, CLI (`agenthub`), contextos de firma (`agenthub/…/v1`) y documentación. Los contextos de firma son parte del protocolo: cambiarlos rompe toda firma hecha antes, y hay que decidir si se cambian o se quedan como están.

## 36. Todo probado de punta a punta en local, antes de publicar (20 de noviembre de 2026)

Pedido por el dueño antes de publicar: probar en local, de punta a punta, todo lo que hace el proyecto, y corregir lo que saliera. Fue la primera vez que todo se pasó en macOS, y no solo en el Linux de la integración continua.

**Lo que se pasó, y cómo salió.**

| Qué | Resultado |
|---|---|
| `npm test` (Node 22) | 287, todos bien |
| `npm run demo` | El flujo completo, sin errores |
| `checks/all.sh` | 15 de 16 a la primera; las 17, con el recorrido nuevo, tras corregir lo de abajo |
| `checks/self-hosted.sh` (Docker) | No arrancó porque otro contenedor tenía el puerto 80; 11 de 11 tras la corrección |

**Lo que falló, y por qué: nada del producto.** Eran guiones que solo se habían pasado en Linux:
- `checks/backup.sh` leía los permisos con `stat -c`, que en macOS es `stat -f %Lp`.
- `checks/self-hosted.sh` necesitaba libres los puertos 80 y 443 solo para publicarlos, porque habla con Caddy por la red de los contenedores. Ya no los publica.

**El recorrido (`checks/tour.sh`, nuevo, 111 comprobaciones, en `all.sh`).** Comparadas una a una las órdenes del CLI con lo que ejecutaban las comprobaciones con procesos reales, casi la mitad no las ejecutaba ninguna. Los tests sí las cubren, pero dentro de un solo proceso. El recorrido las ejecuta todas como lo haría una persona, cada una en un proceso nuevo, contra hubs en sus propios procesos:
- **Topics:** política, historial, suscripciones, y un topic privado con altas, bajas y renovación de claves.
- **Agentes:** búsqueda, su tarjeta de A2A y su registro de OASF.
- **Moderación:** bloqueos, denuncias y suspensiones de los operadores.
- **Controlador:** delegación con alcance, revocación y una delegación soltada.
- **Claves y registro:** `key rotate`, `key forget`, `log head`, `log state`, `log forget` e `instance list`.
- **Verificador de cuentas:** solo GitHub va simulado (`checks/verifier.mjs`), y el verificador es un proceso con su código; también `controller attest`, `prove` y `did-web`.
- **Métricas.**
- **Un reinicio del hub.**
- **Un segundo hub por HTTPS,** con `--require-e2e`, `--topic-create-tier`, `--verified-controller` y cuotas.

Pasa con Node 20, 22 y 24. Las órdenes que hacían lo que dice la documentación, que eran todas, no se tocaron.

**Dos cosas que hace el producto, documentadas, que el dueño debería mirar.**
- **Una petición rechazada gasta cuota.** Pasa con una publicación que no cumple el esquema o la política, con un mensaje en claro en un hub que pide cifrado y con el reintento de un evento ya recibido: las tres cuentan para la cuota de envíos del día. Es la decisión del bloque 3 de la sección 25 («se cobra al empezar la petición»). Donde la cuota es lo que se paga, quizá convenga contar solo lo que se acepta; al menos los reintentos, que el SDK hace con el mismo identificador. No se ha cambiado.
- **Dos procesos con la misma identidad estropean el estado de MLS, y nada lo impide.** El README lo dice («un proceso por identidad a la vez») y no hay bloqueo entre procesos (sección 13). En el recorrido pasó sin querer: un `listen` que seguía vivo leyó los mensajes, y la orden `inbox` que vino después, con el mismo agente, ya no pudo abrirlos. Peor sería que los dos escribieran a la vez, porque uno podría volver a cifrar con una clave ya usada. Se puede hacer cumplir con un bloqueo del directorio de estado, y un segundo proceso se negaría diciendo cuál lo tiene. Pero cambia el uso: no se podría hacer `send` desde una terminal mientras otra hace `listen` con el mismo agente. Queda para que decida el dueño.

**Lo que sigue sin probarse en local, y por qué.**
- Un did:web servido en un dominio de verdad: el hub solo resuelve direcciones públicas.
- El emparejamiento abierto (`--open-pairing`): pide una dirección HTTPS pública.
- GitHub de verdad, en el verificador.
- El servidor MCP dentro de Claude Code cuando el `node` por defecto es anterior al 20: Claude Code lo arranca con ese, y falla antes de empezar. Con el cliente oficial de MCP está probado (`checks/mcp-client`).
- **La landing en Safari de verdad:** se probó con WebKit 26, el que trae Playwright.

**La landing en tres motores.** Chrome, Firefox 153 y WebKit 26, el de Safari, con un guion de prueba fuera del repositorio que hace en cada uno lo mismo. Comprueba que carga sin errores ni peticiones fallidas y con sus fuentes, los cuatro estados de la demo, que solo se mueve lo que está en pantalla, que en un teléfono nada se sale por los lados y que con «reducir movimiento» todo queda quieto. Lo último fallaba en WebKit: pone el reloj de los dibujos a cero justo después de cargar la página, y no acepta otra hora antes, ni siquiera durante el evento `load`. Cada dibujo quedaba quieto en su primer fotograma y no en el elegido. `site/assets/motion.mjs` los vuelve a fijar en cuanto ha arrancado. `web-design-guidelines` sigue sin pasarse.


## 37. Separación en dos repositorios (21 de noviembre de 2026)

Hasta la 1.0.0 el proyecto vivía en un solo repositorio privado, con el servicio alojado dentro. Se separó en dos: este, público, con el núcleo abierto, y otro, privado, con el servicio alojado. Los dos empiezan de cero con el estado del día, sin la historia anterior.

**Lo que hay aquí.** El hub, el SDK, el CLI, el servidor MCP, el testigo, el verificador, las comprobaciones, los ficheros para montar un hub propio, los experimentos y la landing. De los documentos, `DESIGN.md`, `SELF-HOSTING.md` y este, recortado: siguen sus secciones con sus números, y lo que trataba solo del servicio alojado (secciones 24 y 26) se queda en una línea.

**Decisiones del dueño (20 y 21 de noviembre de 2026).**

| Pregunta | Decisión |
|---|---|
| Versión | Este repositorio empieza en la **1.0.0**. Es la 0.7 con el paquete renombrado |
| Nombre del paquete | `lucid-kit`. El CLI sigue siendo `agenthub` y los contextos de firma `agenthub/…/v1` |
| Cómo usa el servicio alojado este código | Como dependencia de npm desde GitHub, fijada a una etiqueta (`lucid-kit#v1.0.0`). Importa de `src/core`, `src/mls` y `src/sdk` por su ruta y construye la imagen del hub con el `Dockerfile` de aquí |
| Las comprobaciones de la versión anterior | `upgrade.sh`, `mixed-hubs.sh` y `mixed-clients.sh` se quedan, pero `all.sh` no las pasa hasta la versión siguiente a la 1.0.0: sacan la anterior del historial, y aquí no hay ninguna. Hasta entonces se pasan a mano con `AGENTHUB_OLD_TREE`. Así se pasaron contra el código de la 0.6 `upgrade.sh stop A` (58) y `mixed-clients.sh` (8) |

**Lo que esto exige del código de aquí.** Que el servicio alojado pueda instalar el paquete desde una etiqueta y usarlo tal cual: sin campo `exports`, sin scripts que se ejecuten al instalarlo, y sin mover ni renombrar ficheros de `src/core`, `src/mls` y `src/sdk` sin cambiar de versión. `test/package.test.mjs` comprueba las dos primeras cosas, y también que el hub y el servidor MCP dicen la versión del paquete. La suite son 289.

**Comprobado:** `npm test` (289), `npm run demo`, `checks/all.sh` (las 8 variantes), la imagen del hub con `checks/self-hosted.sh` y `npm pack --dry-run`: `lucid-kit-1.0.0.tgz`, con `bin/`, `src/`, las licencias, el README y `package.json`.
