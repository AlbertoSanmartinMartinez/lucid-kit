# ALB-317 · Límite por IP exacta: con IPv6 se salta, y el mapa de cubos crece

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-317
- **Rama:** `info/alb-317-m2-rate-limit-por-ip-exacta-con-ipv6-se-salta-y`
- **Prioridad:** Medium
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.

## El problema

Los límites por IP del hub (el global y los de retos, registro, búsqueda, emparejamiento y revocación) usan la dirección exacta como clave. Con IPv6, quien tiene un `/64`, que es lo normal en un servidor alquilado, tiene 2^64 direcciones:

1. **Se salta todos los límites por IP:** cada dirección nueva estrena un cubo lleno.
2. **Llena la memoria:** cada dirección deja un cubo, que el barrido no borra hasta diez minutos después.

Además, leer la ficha de un agente o de un topic solo tiene el límite global.

## Lo que se propone

Lo que dice el issue, sin decisiones nuevas.

## Cambios

### 1. La clave es la red, no la dirección (`src/hub/server.mjs`)

Una función, `networkOf(ip)`, da la clave de todos los límites por IP:

| Dirección | Clave |
|---|---|
| IPv4 | La dirección entera |
| IPv4 escrita como IPv6 (`::ffff:1.2.3.4`) | La IPv4 de dentro |
| IPv6 | Sus primeros 64 bits |
| Otra cosa | `unknown`, como hoy |

Se usa en un solo sitio: donde hoy se calcula la IP del cliente para los límites. Lo que el hub escribe en sus registros sigue siendo la dirección completa.

### 2. Un tope de cubos (`src/hub/ratelimit.mjs`)

`RateLimiter` admite `maxBuckets` (100.000 por defecto). Al pasar de ahí se va el que lleva más tiempo sin usarse. El estado del limitador ya era efímero a propósito: perder un cubo viejo devuelve a esa clave su cupo entero, que es lo mismo que hace el barrido.

### 3. Un tope de peticiones recordadas (`src/hub/server.mjs`)

El hub recuerda cada petición firmada mientras podría repetirse (`nonces`). Ese mapa no se puede desalojar sin abrir la puerta a repeticiones, así que al llegar a su tope (un millón) el hub contesta `503 busy` a las firmadas, como ya hace con los retos pendientes, hasta que caducan las viejas.

### 4. Límite por red en dos lecturas

`GET /v1/agents/:did` y `GET /v1/topics/:name` ganan su propio límite por red (`limits.read`), con el mismo margen que las lecturas del registro.

## Tests

En `test/abuse.test.mjs`:

1. **Dos direcciones del mismo `/64` comparten cubo:** la segunda encuentra gastado lo que gastó la primera. Dos de `/64` distintos, no.
2. **Una IPv4 y la misma escrita como `::ffff:…`** comparten cubo.
3. **El limitador no pasa de `maxBuckets`:** con el tope en 3, la cuarta clave echa a la que llevaba más tiempo sin usarse, y una recién usada se queda.
4. **El tope de peticiones recordadas:** con el tope bajado, la siguiente petición firmada recibe `503 busy`; cuando caducan las viejas, vuelve a pasar. Una repetida sigue rechazándose como repetida.
5. **Las dos lecturas** tienen su límite: pasada la ráfaga, `429`.
6. **Detrás de un proxy** (`trustProxy`), la red sale de la dirección del cliente, no de la del proxy.

## Documentación

- `README.md`, donde habla de los límites: por red y no por dirección. Número de tests, ahí y en `CLAUDE.md`.
- `docs/SELF-HOSTING.md`: qué significa para quien tiene muchos agentes detrás de una misma red (una oficina, un NAT): comparten cupo.
- `docs/HANDOFF.md`: sección nueva.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`: todos sus agentes salen de `127.0.0.1` y comparten red; se confirma que los límites por defecto siguen dando para sus recorridos.

## Fuera de este issue

- **El límite por IP del testigo:** ALB-343.
- **Límites de conexiones y plazos del servidor HTTP:** ALB-318.
- **Prefijos configurables** (`/56`, `/48`): con `/64` basta para el caso del issue.
