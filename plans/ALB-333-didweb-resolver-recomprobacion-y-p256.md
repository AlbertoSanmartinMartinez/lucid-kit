# ALB-333 · `did:web`: resolver por defecto en el SDK, volver a mirar los dominios y claves P-256

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-333
- **Rama:** `info/alb-333-didweb-resolver-por-defecto-en-el-sdk-re`
- **Prioridad:** Medium
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.

## El problema

1. **El SDK no resuelve `did:web` si no se le da con qué.** Para un cliente así, que un agente sea de una organización es la palabra del hub.
2. **El hub mira el `did.json` una sola vez,** al presentar la delegación. Si la organización quita la clave de su documento, la delegación sigue valiendo hasta que caduque (90 días como mucho) o alguien la revoque. Para una empresa que da de baja a alguien, o a la que le roban una clave, es un hueco.
3. **Solo Ed25519.** Un dominio con claves P-256, frecuentes en los sistemas de claves corporativos, no sirve.
4. **La caché se vacía entera** al pasar de 1.000 entradas: con muchos dominios distintos se puede forzar a resolverlos todos otra vez.

## Decisiones del dueño

| Pregunta | Decisión |
|---|---|
| Qué le pasa a una delegación cuya clave ya no está en el `did.json` | **Caduca para siempre,** como una revocación: no se vuelve a presentar, el agente vuelve a ser solo una clave, y queda en el registro. Si fue un error, la organización firma una nueva |
| Hasta dónde llega P-256 | **Solo verificar.** El hub y el SDK aceptan una delegación firmada con una clave P-256 del documento. El CLI no las crea: quien tiene P-256 la tiene en su sistema de claves y firma allí |

## Cambios

Cuatro bloques independientes, un commit cada uno.

### 1. El SDK resuelve por defecto (`src/sdk/index.mjs`)

`resolveDidWeb` pasa a ser `createDidWebResolver()` por defecto. Con `resolveDidWeb: false` se apaga, y sigue pudiéndose dar uno propio.

Lo que cambia para quien usa el SDK, y se documenta: su cliente pide por HTTPS el `did.json` de los dominios que firman delegaciones de los agentes que mira. El dominio ve esa petición. El resultado se guarda cinco minutos.

### 2. El hub vuelve a mirar los dominios (`src/hub/`, `src/core/log.mjs`)

- **Cada cuánto:** `--did-web-recheck HORAS`, 24 por defecto; con 0, nunca. Una petición por dominio y vuelta, espaciadas.
- **Qué cuenta:** solo una respuesta válida del dominio en la que la clave de la delegación **no está**. Si el dominio no contesta, o contesta algo que no es un documento, no se toca nada y el hub se lo dice a su operador.
- **Qué pasa:** una operación nueva, `delegation.lapse`, con la hora en que el hub lo vio. La delegación queda entre las que no se vuelven a presentar, y el agente vuelve a nivel `key`.
- **En el registro de transparencia:** un tipo de entrada nuevo, `delegation.lapse`, con su regla en `Directory`: solo vale para una delegación `did:web` en vigor de ese agente, y después de ella esa delegación no vuelve. Y lo dice al mapa del directorio, como toda regla que cambia algo.

**Lo que esta entrada es y lo que no:** nadie la firma más que el hub. Es lo que el hub dice haber visto. Un cliente la puede contrastar resolviendo él el dominio, que es lo que hace el bloque 1. Un hub que mintiera aquí le quitaría el nivel a un agente; no puede dárselo a nadie.

### 3. Claves P-256, para verificar (`src/core/didweb.mjs`, `src/core/proof.mjs`)

- **En el documento:** se aceptan claves P-256 escritas como JWK (`EC`, `P-256`) y como Multikey.
- **En la prueba de una delegación:** un algoritmo más, ECDSA sobre P-256 con SHA-256, con la firma como `r || s`. Se firma lo mismo de siempre: `contexto + "\n" + JCS(payload)`.
- **Solo donde la clave sale de un `did.json`.** Los agentes, las instancias y los hubs siguen siendo Ed25519: nada más cambia.

Lo que se deja escrito, porque es una construcción nueva en el proyecto: una firma ECDSA admite una segunda forma válida de la misma firma. Aquí no importa, porque una delegación se identifica por su `id` y no por los bytes de su firma, y así se dice en el HANDOFF.

### 4. La caché (`src/core/didweb.mjs`)

Al llenarse, se va la entrada que lleva más tiempo sin usarse, no todas.

## Tests

Los vectores oficiales valen más que las pruebas de ida y vuelta:

1. **ECDSA P-256:** los vectores del RFC 6979 (apéndice A.2.5) se verifican. **Multikey P-256:** el ejemplo de la especificación de `did:key` se decodifica a la clave que dice.
2. **Una delegación `did:web` firmada con P-256** se acepta en el hub y en el SDK; con un byte cambiado, no; con una clave P-256 que no está en el documento, no.
3. **P-256 no vale donde no toca:** una tarjeta de agente o una petición firmadas así se rechazan.
4. **El SDK resuelve por defecto,** y con `resolveDidWeb: false` dice que no lo comprobó (`checked_locally: false`), como hoy.
5. **El hub vuelve a mirar,** con el reloj y el documento inyectados: la clave sigue, no pasa nada; la clave se quitó, la delegación caduca, el agente baja de nivel y hay una entrada en el registro; el dominio no contesta, no pasa nada.
6. **La delegación caducada no se puede presentar otra vez,** ni en este hub ni tras reiniciarlo.
7. **Casos de ataque en el registro:** una entrada `delegation.lapse` para una delegación que no es `did:web`, para una que ya caducó o para un agente que no la tiene, rompe las reglas y los lectores la rechazan.
8. **La caché:** con el tope bajado, se va la menos usada y una recién usada se queda.

Las defensas nuevas del registro llevan su mutación en `experiments/mutations/logstate.py`.

## Documentación

- `README.md`: el SDK resuelve por defecto y a quién contacta; el hub vuelve a mirar los dominios; P-256, con los bytes exactos que tiene que firmar quien use su sistema de claves. Número de tests, ahí y en `CLAUDE.md`.
- `examples/`: un ejemplo que firma una delegación con una clave P-256 con `node:crypto`, en el papel del sistema de claves.
- `docs/HANDOFF.md`: sección nueva con las dos decisiones, lo que `delegation.lapse` garantiza y lo que no, y lo de ECDSA.
- `docs/SELF-HOSTING.md`: `--did-web-recheck`.
- `CLAUDE.md`, reglas «Firmas» y «Registro de transparencia».

## Comprobación

- `npm test` en verde antes y después.
- Las mutaciones: todas cazadas.
- `bash checks/all.sh`.

## Lo que no queda verificado

Un dominio de verdad con una clave P-256 de un sistema de claves de verdad. Se puede añadir al recorrido de ALB-330.

## Fuera de este issue

- **Crear claves P-256 con el CLI,** y secp256k1.
- **Avisar a la organización** cuando una de sus delegaciones caduca así.
- **Los puertos de `did:web` y el error de resolución que se devuelve al cliente:** ALB-341.
