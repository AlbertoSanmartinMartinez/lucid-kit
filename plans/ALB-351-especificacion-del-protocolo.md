# ALB-351 · Publicar una especificación del protocolo (`SPEC.md`)

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-351
- **Rama:** `info/alb-351-publicar-una-especificacion-del-protocolo`
- **Prioridad:** Medium
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada escrito.
- **Va después de ALB-346:** el renombrado cambia los contextos de firma y las cabeceras. La especificación se escribe con los nombres que queden.

## El problema

La web presenta LUCID como un protocolo abierto. Hoy el protocolo solo existe en el JavaScript y en el README. `docs/DESIGN.md` describe otra arquitectura (el diseño objetivo, con Rust, NATS y PostgreSQL), no lo construido. Nadie puede escribir un cliente en Python o en Go sin leer el JavaScript.

## Decisión del dueño

**En inglés.** Es para quien implementa en otro lenguaje: su público lee inglés. Otra excepción a «documentación en español», como el README.

## Qué cubre la primera versión

Lo que pide el issue, y con eso basta para escribir un cliente que se registre, publique, lea y compruebe lo que recibe:

| Capítulo | Qué fija |
|---|---|
| Identidades | `did:key` con Ed25519, y cómo se codifica |
| El sobre firmado | Qué bytes se firman (`contexto + "\n" + JCS(payload)`), la prueba fuera del payload, y la lista de contextos |
| Peticiones firmadas | Las cabeceras, qué se firma, para qué hub, y cómo se rechaza una repetida |
| La API HTTP | Cada ruta: método, autenticación, cuerpo, respuesta y códigos de error estables |
| El registro de transparencia | Los tipos de entrada, las reglas que cumple un registro bien llevado, el árbol de RFC 6962 y el estado firmado en el formato de C2SP |
| Direcciones | `did@hub` y `topic@hub` |

Y un apartado, **«Not specified yet»**, que nombra lo que el protocolo tiene y esta versión no describe: el perfil de MLS (conversaciones y topics privados), la federación entre hubs, los testigos, el relevo de claves, la tarjeta de A2A y el mapa del directorio. Cada uno entra en una versión posterior. Decirlo es parte de la honestidad del documento: mejor una especificación corta que diga lo que le falta que una larga que no sea verdad.

## Cómo se escribe

- **`SPEC.md`, en la raíz,** con su versión arriba y un registro de cambios propio al final. La versión de la especificación no es la del paquete.
- **Describe el protocolo, no el código.** No nombra ficheros ni funciones de este repositorio.
- **Usa las palabras de siempre** para lo obligatorio y lo recomendado (MUST, SHOULD, MAY).
- **Sale del código, no del README.** Cada regla se comprueba contra lo que el hub y el SDK hacen de verdad; donde el README y el código no coincidan, manda el código y se corrige el README.

## Vectores de prueba

En `spec/vectors/`, en JSON, uno por capítulo: las entradas, los bytes intermedios y el resultado. Con claves y horas fijas, para que salgan siempre iguales (las firmas Ed25519 son deterministas).

- **Los escribe una herramienta** (`spec/tools/vectors.mjs`) con el núcleo de verdad, como la landing ya hace con sus bytes del protocolo. No se editan a mano.
- **Un test** comprueba que la implementación los reproduce byte a byte: si el protocolo cambia sin querer, falla.
- **Donde hay vectores oficiales** (RFC 8785 para JCS, RFC 6962 para el árbol, C2SP para el estado firmado), la especificación remite a ellos y no inventa otros.

## `docs/DESIGN.md`

Una nota al principio: es el diseño objetivo, no lo construido, y no es la especificación del protocolo, que está en `SPEC.md`.

## Tests

- `test/spec.test.mjs`, nuevo: los vectores se reproducen, y los que guarda el repositorio son los que escribe la herramienta.
- **Cada código de error y cada ruta que nombra la especificación existe en el hub,** y al revés: una ruta nueva sin su sitio en la especificación hace fallar el test. Se apoya en la lista de rutas de ALB-325 si ya está; si no, la saca del hub de prueba.
- **Cada contexto de firma** del núcleo está en la especificación.

## Documentación

- `README.md` y la landing: enlace a la especificación. La frase «open protocol», que ALB-350 suaviza, puede volver con ese enlace.
- `CLAUDE.md`: quien cambia el protocolo cambia la especificación y regenera los vectores, en el mismo cambio. Y la especificación, en inglés.
- `docs/HANDOFF.md`: sección nueva: qué cubre, qué no y por qué.

## Comprobación

- `npm test`.
- **Leerla sin el código delante.** Alguien, o una sesión nueva sin acceso a `src/`, escribe con solo `SPEC.md` y los vectores un verificador mínimo de un evento firmado, en otro lenguaje. Lo que no pueda hacer sin preguntar es un hueco de la especificación.

## Fuera de este issue

- **Los capítulos de «Not specified yet».**
- **Una segunda implementación,** más allá de la prueba de lectura.
- **Llevarla a un organismo de estándares.**
