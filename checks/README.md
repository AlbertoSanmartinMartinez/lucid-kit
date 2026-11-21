# Comprobaciones con procesos reales

Guiones que arrancan hubs de verdad en esta máquina, cada uno en su proceso y con sus datos en disco, y les hablan con el CLI: cada orden es un proceso nuevo que lee su estado del disco, como lo usaría una persona. Comprueban lo que los tests no ven, porque los tests arrancan los hubs dentro del propio proceso: que el estado vuelve del disco, que dos hubs se entienden por la red, que una versión anterior y esta conviven, y que el servidor MCP funciona con un cliente de MCP que no es el nuestro.

No son parte de `npm test`: arrancan procesos, ocupan puertos y tardan. Todas juntas, unos dos minutos. Se pasan antes de cerrar un bloque que toque el almacén, la federación, MLS, el CLI o el servidor MCP.

## Cómo se usan

```bash
npm install                                  # en la raíz, si no está hecho
(cd checks/mcp-client && npm ci)             # una vez: el cliente oficial de MCP, para su comprobación
(cd checks/a2a-client && npm ci)             # una vez: el SDK oficial de A2A, para la suya

bash checks/all.sh                           # todas, en todas sus variantes

bash checks/two-hubs.sh [A|B]
bash checks/upgrade.sh [stop|kill] [A|B]
bash checks/mixed-hubs.sh [new-old|old-new] [A|B]
bash checks/mixed-clients.sh
bash checks/backup.sh
bash checks/witness.sh
bash checks/succession.sh
bash checks/tour.sh
bash checks/mcp-client/run.sh
bash checks/a2a-client/run.sh
```

Cada guion escribe una línea por comprobación (`ok   - …` o `FAIL - …`), acaba con una línea `RESULT:` y sale con 0 si pasaron todas, con 1 si falló alguna y con 2 si no pudo empezar (un puerto ocupado, un argumento que no es, una herramienta que falta).

| Guion | Qué comprueba | Comprobaciones | Variantes |
|---|---|---|---|
| `two-hubs.sh` | Dos hubs emparejados con `--peer` y un agente en cada uno. Se encuentran al buscar y hablan sobre MLS a través de los dos hubs; cada uno renueva sus claves; lo que necesitó una renovación se abre con el otro hub parado; los dos hubs se paran y arrancan de lo que tienen en disco y la conversación sigue; una segunda instancia entra, contesta, se la retira y deja de leer; los dos registros se sostienen; y en el disco y en la salida de los hubs no queda una palabra de lo que se dijeron | 48 | La casa de la conversación en cada hub |
| `upgrade.sh` | Actualizar sin tocar nada. Con el código de la versión anterior, dos hubs y cuatro agentes dejan a medias una renovación de claves con un mensaje sin leer, una invitación sin recoger, un evento de un topic privado y un mensaje a otro hub. Después el código de este árbol sigue sobre los mismos datos y el mismo estado de cada agente: lo que esperaba se lee, las conversaciones siguen en el grupo que tenían, la de los dos hubs pasa a MLS y el hub que no es su casa guarda copia de los commits | 58 | Los hubs antiguos parados como lo haría un operador (`stop`: dejan una copia en disco) o matados en seco (`kill`: el código nuevo reproduce el diario del antiguo), con la casa en cada hub |
| `mixed-hubs.sh` | Dos hubs emparejados, uno de cada versión, cada agente con el CLI de la versión de su hub. Desde que las peticiones se firman para la dirección del hub, uno de antes y uno de ahora no se aceptan las peticiones: el de ahora lo dice al emparejarse, y nada cruza. Después se actualiza el hub antiguo sobre sus datos y todo cruza: búsqueda, conversación MLS con una renovación y topics públicos en los dos sentidos | 27 | Qué hub empieza siendo el antiguo, con la casa en cada hub |
| `mixed-clients.sh` | Un hub de una versión y el CLI de la otra: ninguno acepta lo que firma el otro, y lo dice con su código (`unbound_request` el hub nuevo, `invalid_signature` el antiguo); con el CLI de la versión del hub, la misma clave se registra y habla | 8 | Las dos combinaciones, en una pasada |
| `backup.sh` | Una copia de los datos de un hub hecha con él en marcha (`deploy/self-hosted/backup.sh`), y un hub arrancado de ella en otro puerto: la misma clave, los mismos agentes y topics, un registro que se sostiene, y lo que esperaba en un buzón antes de la copia | 14 | — |
| `mcp-client/run.sh` | Dos servidores MCP de este árbol, cada uno un proceso con su identidad, manejados por el cliente oficial de MCP contra un hub con la prueba de trabajo por defecto (18 bits): las 12 herramientas en un flujo entre dos agentes, los errores como errores de herramienta y lo ajeno marcado como no fiable | 24 | — |
| `a2a-client/run.sh` | Las tarjetas de A2A que sirve un hub de este árbol, leídas y verificadas con el SDK oficial de A2A y nada de este repositorio: su cliente encuentra la tarjeta donde el hub la sirve, su verificador acepta la firma y dice de qué agente es, la rechaza con una palabra cambiada, y su cliente no toma al agente por uno al que pueda llamar. También lo que enseña el CLI (`agent a2a`) | 15 | — |
| `witness.sh` | Un testigo, un hub que le enseña su registro y agentes que lo piden, cada uno un proceso. El estado del hub vuelve cofirmado; un agente que se fía del testigo trabaja y uno que pide un testigo que el hub no tiene queda rechazado, sin llegar a registrarse; lo que el registro dice de un agente se pide y se comprueba sin leerlo, contra lo que firma el hub y contra lo que cofirmó el testigo; el testigo, parado y arrancado, es el mismo y recuerda lo que cofirmó; y un hub que vuelve con la misma clave y menos registro no se cofirma, lo dice, y quien pide el testigo deja de creerle | 23 | — |
| `succession.sh` | Un agente que cambia de clave, cada paso una orden del CLI. Uno con clave de recuperación: quien tiene su clave no puede relevarlo ni nombrar otro guardián, y la clave de recuperación sí; lo firmado para un sucesor no le sirve a otro. Después del relevo, y otra vez tras parar y arrancar el hub: quién está en su lugar, a quién pasa su topic, qué se le dice a quien le escribe, y que el registro se sostiene. Su topic privado sale con un grupo nuevo que hizo el sucesor, sin el primer agente, y su miembro lee ahí. Uno que actúa por un controlador queda guardado por él sin decirlo, y el controlador firma el relevo sin llegar al hub. Uno sin guardián se releva con su propia clave, y no con otra; y uno sin guardián que fue retirado ya no se releva | 40 | — |
| `tour.sh` | El recorrido: lo que una persona hace con el CLI y ninguna otra comprobación hace, cada cosa una vez, con un hub, un verificador y un segundo hub por HTTPS, cada uno en su proceso. El inicio rápido del README tal cual, con `listen --model`, que se para con Ctrl+C; la política de un topic, lo que conserva y quién lo sigue; un topic privado al que entran y del que salen agentes, que leen desde que entran y nada después de salir, y una renovación de claves; buscar agentes, su tarjeta de A2A y su registro de OASF; bloquear, denunciar y lo que hacen con ello los operadores (`admin`); un controlador que delega con un alcance que se cumple y revoca, y una delegación que se suelta y ya no se presenta; `key rotate`, `key forget`, `log head`, `log state`, `log forget` e `instance list`; el verificador de cuentas, con un GitHub simulado (`verifier.mjs`), que hace de nivel `account` a los agentes de un controlador, y `controller attest`, `prove` y `did-web`; las métricas, sin un DID; el hub parado y arrancado, con lo que tenía; y un hub por HTTPS con su certificado, `--require-e2e`, `--topic-create-tier account`, `--verified-controller` y cuotas | 111 | — |

`all.sh` pasa las ocho variantes de las que no necesitan otra versión, y sale con 0 solo si todas se pasaron y ninguna falló. Las tres de versiones (`upgrade.sh`, `mixed-hubs.sh` y `mixed-clients.sh`) no las pasa hasta la versión siguiente a la 1.0.0: sacan la versión anterior del historial, y este repositorio empieza en la 1.0.0. Hasta entonces se pasan a mano contra el código de la 0.6, con `AGENTHUB_OLD_TREE` (abajo).

Fuera de `all.sh`, porque necesita Docker con Compose. No ocupa los puertos 80 y 443 de la máquina: habla con Caddy por la red de los contenedores, así que se pasa también donde otra cosa los tiene. Lo único del fichero de la guía que no prueba es que los publique:

| Guion | Qué comprueba | Comprobaciones |
|---|---|---|
| `self-hosted.sh` | Los ficheros que recibe quien monta su propio hub (`deploy/self-hosted/`), usados como dice la guía: `docker compose up` con el nombre del hub. El hub y Caddy arrancan, el hub dice su clave, dos agentes se registran y hablan sobre MLS a través de Caddy por TLS, el registro se sostiene, HTTP se redirige a HTTPS, y tras parar y arrancar es el mismo hub y lo que esperaba en un buzón sigue ahí. El nombre es `hub.localhost`, para el que Caddy se firma el certificado: no prueba un certificado de verdad | 11 |

## Qué necesitan

- `bash`, `curl`, `tar` y Node 20 o superior, con las dependencias de la raíz instaladas.
- Para las tres que usan la versión anterior, su código en un directorio, con sus dependencias instaladas (`AGENTHUB_OLD_TREE`). A partir de la versión siguiente a la 1.0.0, git y el historial del repositorio bastarán: el commit se saca del clon o se trae de `origin`.
- Los puertos 18801 a 18886 de `127.0.0.1` libres, o los que se elijan con `AGENTHUB_CHECK_PORT`.
- Para `tour.sh`, `openssl`, que hace el certificado del hub por HTTPS.
- Para `mcp-client`, su propia dependencia, `@modelcontextprotocol/sdk` 1.32.2, fijada a esa versión y fuera de las del producto. `npm ci` necesita red.
- Para `a2a-client`, la suya, `@a2a-js/sdk` 1.3.0 (que trae `jose`), también fijada y fuera de las del producto.

| Variable | Para qué |
|---|---|
| `AGENTHUB_CHECK_PORT` | El puerto a partir del cual se cuentan los que usa cada comprobación. Por defecto 18800 |
| `AGENTHUB_CHECK_DIR` | Dónde deja una comprobación los datos de sus hubs, lo que escriben y las claves de sus agentes. No puede existir, y se queda al acabar. Sin ella se usa un directorio temporal, que se borra si todo pasa y se deja, diciendo dónde, si algo falla. Con `all.sh`, dentro queda lo de cada pasada (`run-1.txt`, `run-1/`…) |
| `AGENTHUB_OLD_REV` | El commit de la versión anterior. Por defecto, el último de la 0.6 |
| `AGENTHUB_OLD_TREE` | Un directorio con el código de la versión anterior y sus dependencias, en vez de sacarlo del historial |

## Cuando algo falla

El directorio de la comprobación se queda, y el resultado dice dónde. Dentro están los datos de cada hub (`a/`, `b/`…, con su `journal.jsonl` y su `snapshot.json`), lo que escribió (`a.log`), la clave de cada agente (`alice.json`) y su estado de MLS (`alice.json.state/`). Las claves son de usar y tirar. Con `AGENTHUB_CHECK_DIR` se elige el sitio de antemano.

## Reglas que cumplen, y que hay que mantener al tocarlas

- **Un hub se para por su PID,** nunca por un patrón que pueda coincidir con el proceso de otro.
- **Una comprobación no empieza si ya contesta alguien en un puerto que va a usar,** y mira que el proceso que arrancó es el que contesta. Un hub que quedó en marcha de una pasada anterior haría que todo hablara con él y dijera lo que él diga: pasó una vez, y por eso está.
- **Lo que una comprobación arrancó se para cuando acaba,** acabe como acabe.
- **No se canalizan por `head`:** al cerrarse la tubería el guion muere y sus hubs se quedan en marcha.
- **En qué hub queda la casa de una conversación se elige,** no se deja al azar de las claves: las claves de los dos agentes se hacen antes y se reparten según la casa que se pide.
- **Lo que cruza de un hub a otro por un stream se lee con reintentos** (`reads_soon`), no con una espera fija.

## La versión anterior

Las tres comprobaciones de versiones están escritas contra la 0.6. Lo que tiene de propio la 0.6: un mensaje directo a otro hub va sellado con HPKE (`OLD_ACROSS` en `upgrade.sh`), y sus peticiones no se firman para la dirección del hub, así que ni un hub ni un CLI de ahora las aceptan ni ella acepta las suyas (`mixed-hubs.sh` y `mixed-clients.sh` lo comprueban así). Este repositorio empieza en la 1.0.0, así que la 0.6 no está en su historial: hasta la versión siguiente, estas tres se pasan a mano con `AGENTHUB_OLD_TREE`. Al cerrar esa versión, `OLD_REV` en `lib.sh` pasa a ser `v1.0.0` y se ajustan esas expectativas, porque la 1.0.0 y la siguiente sí se entienden.

## Lo que no cubren

- Dos máquinas, una red de verdad entre los hubs, TLS.
- Un hub, un agente o un hub emparejado que mienten: eso son los tests, con sus casos de ataque.
- Versiones anteriores a la 0.6.
- Carga, ni muchos agentes a la vez.
- De lo que recorre `tour.sh`: un did:web servido en un dominio de verdad (el hub solo resuelve direcciones públicas), el emparejamiento abierto (`--open-pairing`, que pide una dirección HTTPS pública), GitHub de verdad, y `controller prove --submit` contra la consola de un servicio.
