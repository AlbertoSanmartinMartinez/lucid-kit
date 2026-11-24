# ALB-341 · `did:web`: se acepta cualquier puerto, y el error de resolución se devuelve al cliente

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-341
- **Rama:** `info/alb-341-seguridadlow-didweb-se-acepta-cualquier-puerto`
- **Prioridad:** Low (seguridad)
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.

## El problema

Dos detalles de cómo el hub resuelve un `did:web`, que ALB-333 no cubre:

1. **Vale cualquier puerto.** Un `did:web` puede nombrar un puerto, y el hub pide el documento ahí. La comprobación de que la dirección es pública ya impide llegar a la red interna, pero quien presenta una delegación puede hacer que el hub llame a un servicio público de otro en el puerto que quiera.
2. **El detalle del fallo vuelve a quien preguntó.** Cuando no se puede resolver el dominio, la respuesta `issuer_unresolved` lleva el texto del error de dentro, que cuenta qué contestó el destino. Pasa en dos sitios: al presentar una delegación y al presentar una revocación.

Juntos hacen del hub una forma, pobre pero gratuita, de sondear puertos de terceros.

## Lo que se propone

El issue ofrece «solo el 443» o una lista configurable de puertos. Este plan elige **solo el 443, sin opción,** a falta de que el dueño diga otra cosa: un `did:web` con puerto propio es rarísimo, y una lista configurable es una opción más que explicar y que probar para casi nadie.

## Cambios

### 1. Solo el puerto por defecto (`src/core/didweb.mjs`)

Un `did:web` con un puerto que no sea el 443 deja de ser válido: se rechaza al leerlo, antes de pedir nada. Escrito sin puerto, o con el 443, sigue valiendo.

Está en el núcleo, así que vale igual para el hub y para el SDK, que con ALB-333 resuelve por defecto.

### 2. El detalle se queda en el hub (`src/hub/server.mjs`)

En los dos sitios que contestan `issuer_unresolved`:

- **A quien llama:** el código y una frase fija: `the domain that issued it could not be checked`. Sin el texto del error.
- **Al operador:** el detalle, en la salida del hub, con el dominio entre comillas y sin caracteres de control, como todo lo que el hub escribe de lo que eligió otro.

Los errores que **no** son de resolución (una firma que no vale, una delegación caducada) siguen diciendo qué está mal: eso lo necesita quien la presenta, y no cuenta nada de un tercero.

## Tests

En `test/trust.test.mjs`, con sus casos de ataque:

1. **Un `did:web` con el puerto 8443** se rechaza, y no sale ninguna petición hacia ese dominio.
2. **Sin puerto, y con el 443 escrito,** se aceptan.
3. **Un dominio que no se puede resolver, al presentar una delegación:** la respuesta lleva el código y la frase fija, y ni una palabra de lo que contestó el destino. El doble del dominio contesta un texto reconocible, y el test comprueba que no está en la respuesta y sí en la salida del hub.
4. **Lo mismo al presentar una revocación.**
5. **Una delegación con la firma mal** sigue diciendo que es la firma.

## Documentación

- `README.md`, donde habla de `did:web`: solo el puerto por defecto. Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva, corta.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`.

## Fuera de este issue

- **Volver a mirar los dominios, las claves P-256 y la caché:** ALB-333.
- **La resolución contra un dominio de verdad:** ALB-330.
