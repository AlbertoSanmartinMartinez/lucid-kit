# ALB-332 · MCP: la revisión 2026-07-28 y el transporte HTTP, en local

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-332
- **Rama:** `info/alb-332-mcp-soportar-la-revision-2026-07-28-y-el`
- **Prioridad:** Medium
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.
- **Va después de ALB-303 y ALB-307:** el transporte nuevo hereda la cola de llamadas, la cancelación y la entrega de `hub_inbox`.

## El problema

1. **El servidor MCP no habla la revisión 2026-07-28.** Esa revisión quita el saludo inicial (`initialize`) y hace el protocolo sin estado: empieza por `server/discover`. Hoy el servidor contesta «método no encontrado» y confía en que el cliente vuelva al saludo antiguo. Funciona, pero dejará de hacerlo cuando los clientes abandonen ese camino.
2. **Solo se sirve por stdio.** No hay transporte HTTP, y sin él no se puede ofrecer alojado.

## Decisión del dueño

**La revisión nueva, y HTTP solo en local.** `mcp --http` sirve en `127.0.0.1` con un token, y la clave del agente sigue en la máquina del usuario. El servidor alojado, que obliga a decidir dónde vive esa clave, pasa a un issue aparte.

## Paso 0: leer la especificación

La revisión es posterior a lo que este plan puede dar por sabido. Lo que sigue sale de su anuncio y de su registro de cambios, consultados el 24 de noviembre de 2026, y **se contrasta con el texto de la especificación antes de escribir código**:

- `server/discover` es obligatorio: dice qué versiones habla el servidor, qué sabe hacer y quién es.
- No hay `initialize` ni sesión: cada petición lleva la versión del protocolo y lo que sabe hacer el cliente.
- Cada resultado lleva `resultType` (`complete`, o `input_required` para los que piden algo más).
- Por HTTP, cada petición lleva las cabeceras `Mcp-Method` y `Mcp-Name`.
- Raíces, muestreo y logging quedan en desuso. Este servidor no usa ninguno. Las fuentes no coinciden en si `ping` desaparece.

Y se sube el SDK oficial de `checks/mcp-client` (hoy `1.32.2`) a la versión que hable la revisión nueva.

## Cambios

### 1. La revisión 2026-07-28, por stdio (`src/mcp/server.mjs`)

- **`server/discover`**, con las versiones que habla el servidor (la nueva y las cuatro de hoy), sus capacidades y su nombre.
- **Peticiones sin saludo previo:** si la petición dice que es de la revisión nueva, se atiende tal cual, y su resultado lleva `resultType: "complete"`.
- **`initialize` se queda** para los clientes de 2025-11-25 y anteriores. Para ellos no cambia nada.

### 2. `mcp --http`: HTTP en local (`src/mcp/http.mjs`, nuevo, y el CLI)

`agenthub mcp --http [--port N]`:

- **Solo en `127.0.0.1`.** No hay opción para escuchar fuera: eso es el servidor alojado, que es otro issue.
- **Con un token.** Se crea la primera vez, se guarda junto a la identidad con permisos `0600`, y el servidor dice dónde está al arrancar. Sin él, o con otro, `401`. Se compara en tiempo constante.
- **Se rechaza una petición con un `Origin` que no sea local.** Es la defensa que pide MCP contra una página web que intente hablar con un servidor de la máquina del usuario.
- **Solo la revisión nueva.** Sin estado, cada `POST` es una petición con su respuesta en JSON. Los clientes antiguos siguen por stdio: sus sesiones por HTTP serían código para un camino que se está retirando.
- **La misma identidad, la misma cola y las mismas reglas** que por stdio: las llamadas a herramientas van de una en una, se cancelan igual, y lo que abrió `hub_inbox` se guarda hasta que su respuesta ha salido.
- **Plazos y tope de tamaño** en el servidor HTTP, como los del hub (ALB-318).

Un proceso sirve por stdio o por HTTP, no por los dos.

## Tests

En `test/mcp.test.mjs`:

1. **Un cliente de la revisión nueva conecta sin dar un rodeo:** `server/discover` y una llamada a herramienta, sin `initialize`. El resultado lleva `resultType`.
2. **Un cliente de 2025-11-25 sigue funcionando:** el saludo grabado de Claude Code, que ya es un test, pasa sin tocarlo.
3. **Por HTTP:** una llamada con el token funciona; sin token o con otro, `401`; con un `Origin` de fuera, se rechaza; sin las cabeceras que pide la revisión, se rechaza.
4. **`--http` no escucha fuera de la máquina:** desde otra dirección de la propia máquina, nadie contesta.
5. **Lo que llega al modelo por HTTP** va envuelto igual que por stdio.
6. **`hub_inbox` por HTTP:** si la respuesta no llegó a salir, el lote se repite en la siguiente llamada.

En `checks/mcp-client/`, con el SDK oficial:

7. El recorrido de hoy, con la revisión nueva y con la anterior.
8. **El mismo recorrido por Streamable HTTP.**

## Los criterios del issue

| Criterio | Cómo queda |
|---|---|
| Un cliente con 2026-07-28 conecta sin dar un rodeo | Tests 1 y 7 |
| Los clientes con 2025-11-25 siguen funcionando | Tests 2 y 7 |
| Un check con el SDK oficial por Streamable HTTP pasa | Test 8 |
| `server.json` declara `remotes` | **Abierto.** No hay nada que declarar hasta que exista un servidor alojado en una dirección pública |

## Documentación

- `README.md`, en la parte de MCP: las revisiones que habla el servidor, `mcp --http`, dónde está el token y cómo se configura un cliente con él. Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva: lo decidido, lo contrastado con la especificación y lo que queda para el servidor alojado.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`, que pasa `checks/mcp-client`.
- A mano, con un cliente que hable la revisión nueva, junto a las pruebas de ALB-305.

## Fuera de este issue: el servidor alojado

Queda para su propio issue, que empieza por una decisión de diseño y de seguridad. Un punto de partida que encaja con lo que el proyecto ya tiene: **el servidor alojado actúa como una instancia del agente**, con su propia clave y un certificado que el usuario firma y puede retirar. La clave del agente no sale de su máquina. Ese issue trae también la autenticación de los usuarios, `remotes` en `server.json` y lo que toca construir en el repositorio del servicio alojado.

## Fuentes

- [Registro de cambios de la revisión 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [Anuncio de la revisión](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
