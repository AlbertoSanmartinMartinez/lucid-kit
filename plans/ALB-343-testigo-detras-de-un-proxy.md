# ALB-343 · Testigo: límite por la IP del socket, sin `trustProxy` y sin TLS propio

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-343
- **Rama:** `info/alb-343-seguridadlow-witness-rate-limit-por-ip-del`
- **Prioridad:** Low (seguridad)
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.
- **Va después de ALB-317** (el límite por red) **y de ALB-331** (el verificador detrás de un proxy): hace lo mismo que ellos, para el testigo.

## El problema

1. **El testigo limita por la dirección de quien se conecta,** y no tiene forma de decirle que está detrás de un proxy. Detrás de uno, todas las peticiones llegan con la dirección del proxy y comparten un solo cupo: un cliente ruidoso agota el de todos, y el testigo deja de cofirmar.
2. **No sirve HTTPS,** y nada dice cómo ponerle un proxy delante.

Lo que el testigo contesta es público y va firmado, así que ir en claro no deja falsificar nada. Lo que se pierde sin proxy es poco; lo que se pierde detrás de uno es el servicio.

## Lo que se propone

Lo mismo que ya se decidió para el hub y para el verificador, sin decisiones nuevas:

- **Detrás de un proxy, la dirección del cliente** se saca como en el hub, y el límite va por red (ALB-317).
- **HTTPS, con un proxy delante,** documentado y con sus ficheros en `deploy/self-hosted/`, como el verificador en ALB-331. Sin TLS propio: una sola forma de desplegar los tres servicios.

## Cambios

### 1. Una sola forma de saber quién llama (`src/core/clientip.mjs`, nuevo)

Hoy el hub y el verificador llevan cada uno su copia de la misma función: con N proxies de confianza delante, el cliente es la entrada N contando desde el final de `X-Forwarded-For`; sin ninguno, la dirección de la conexión, y la cabecera se ignora. Se saca a un sitio común, junto a la red de una dirección que añade ALB-317, y la usan los tres: hub, verificador y testigo.

### 2. El testigo (`src/witness/server.mjs` y el CLI)

- **`trustProxy`,** opción nueva, y `--trust-proxy N` en `agenthub witness`. Por defecto 0, como hoy.
- **El límite, por la red del cliente.**

### 3. El despliegue (`deploy/self-hosted/`)

El testigo como servicio opcional del `docker-compose.yml`, detrás de Caddy, igual que el verificador. Quien opera un testigo lo hace para el hub de **otra** persona: el fichero lo deja claro, para que nadie monte su hub y su propio testigo juntos creyendo que eso le da algo.

## Tests

En `test/witness.test.mjs`:

1. **Detrás de un proxy de confianza,** dos clientes distintos tienen cada uno su cupo.
2. **Sin proxy de confianza,** la cabecera `X-Forwarded-For` se ignora: quien la falsea no estrena cupo.
3. **Con un proxy de confianza,** una cabecera con más entradas de la cuenta no engaña: se toma la que pone el proxy, no la que manda el cliente.
4. **Dos direcciones del mismo `/64`** comparten cupo.
5. **Lo de siempre no cambia:** qué cofirma el testigo, y que lo deja escrito en disco antes de contestar.

En `test/hub.test.mjs` y `test/verifier.test.mjs`: los tests de `trustProxy` que ya hay siguen pasando con la función común.

En `checks/self-hosted.sh`: el testigo contesta por HTTPS detrás de Caddy.

Lo que cambia aquí no toca las reglas del testigo; aun así se pasa `experiments/mutations/witness.py`: todas cazadas.

## Documentación

- `docs/SELF-HOSTING.md`, en el apartado de testigos: cómo se monta uno detrás de un proxy y `--trust-proxy`.
- `README.md` y `CLAUDE.md`: número de tests.
- `docs/HANDOFF.md`: sección nueva, corta.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh` (que pasa `witness.sh`) y `checks/self-hosted.sh`.

## Fuera de este issue

- **TLS propio en el testigo.**
- **Una red de testigos,** o probar con los públicos de C2SP.
- **Plazos y tope de conexiones del servidor del testigo:** ALB-318.
