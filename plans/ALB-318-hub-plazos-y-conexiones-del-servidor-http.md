# ALB-318 · Hub: el servidor HTTP no tiene límites de conexiones ni plazos propios

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-318
- **Rama:** `info/alb-318-m3-hub-el-servidor-http-no-tiene-limites-de`
- **Prioridad:** Medium
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.

## El problema

El hub crea su servidor HTTP sin opciones, así que valen las de Node: 60 s para mandar las cabeceras, 300 s para mandar la petición entera y conexiones sin límite.

Con un proxy delante da igual. Pero el hub también se puede servir directo (`--tls-cert` y `--tls-key`, documentado en el README), y ahí queda expuesto a quien abre miles de conexiones y manda cada petición muy despacio: agota los descriptores de fichero sin gastar un solo cupo, porque el límite cuenta peticiones y no conexiones.

## Lo que se propone

Los valores del issue, con un ajuste: `keepAliveTimeout` no se toca. El valor que propone (5 s) es el que Node ya trae, y subirlo o bajarlo sin motivo da problemas con los proxies.

| Qué | Hoy | Pasa a |
|---|---|---|
| Plazo para mandar las cabeceras | 60 s | 10 s |
| Plazo para mandar la petición entera | 300 s | 30 s |
| Conexiones abiertas a la vez | Sin límite | 10.000, configurable |

## Cambios

### 1. El hub (`src/hub/server.mjs`)

- Los dos plazos, al crear el servidor.
- **`maxConnections`**, opción nueva (10.000 por defecto), y `--max-connections N` en el CLI. Cada stream abierto de un agente es una conexión: el tope es también el de agentes conectados a la vez, y así se documenta.
- **Los streams no se cortan.** El plazo de la petición cuenta lo que tarda en llegar la petición, no lo que dura la respuesta. Un test lo fija.

### 2. El verificador, el testigo y las métricas

Los mismos dos plazos en sus servidores (`src/verifier/server.mjs`, `src/witness/server.mjs`, `src/hub/metrics.mjs`), con un tope de conexiones de 1.000: ninguno tiene streams.

### 3. Lo que el hub cuenta

`/v1/info` ya enseña sus límites: se añade el de conexiones.

## Tests

En `test/requests.test.mjs`, con los plazos bajados a décimas de segundo:

1. **Cabeceras que no acaban de llegar:** el hub cierra la conexión al vencer el plazo.
2. **Un cuerpo que llega gota a gota:** lo mismo, al vencer el de la petición.
3. **Un stream abierto sigue abierto** bastante después de vencidos los dos plazos, y sigue recibiendo eventos.
4. **Una conexión de más:** con el tope en 2, la tercera se rechaza; al cerrar una, entra otra.
5. **Una petición normal** no nota nada.

Lo mismo, en corto, para el verificador y el testigo en sus ficheros de tests.

## Documentación

- `README.md` y `docs/SELF-HOSTING.md`: `--max-connections`, qué limita (agentes conectados a la vez) y los plazos. En SELF-HOSTING, que detrás de un proxy el tope tiene que dar para lo que el proxy abre. Número de tests, en el README y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh` y `checks/self-hosted.sh`, que pone a Caddy delante del hub: se confirma que el proxy y el hub se entienden con los plazos nuevos.

## Fuera de este issue

- **Límites por red y tope de cubos:** ALB-317.
- **El apagado ordenado:** ALB-319.
- **TLS propio del testigo:** ALB-343.
