# ALB-326 · Hallazgos menores de la revisión completa (B1 a B10)

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-326
- **Rama:** `info/alb-326-b1-b10-hallazgos-menores-de-la-revision`
- **Prioridad:** Low
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada implementado.

## El problema

Nueve hallazgos pequeños de la revisión, sin relación entre sí. B8 (la CI) ya está en ALB-313 y no se repite.

## Decisión del dueño

**B4: un topic suspendido no se lee.** Contesta `403 topic_suspended` también al pedir su ficha y su historial. Se suspende por abuso o por contenido ilegal: dejar el contenido legible deja la suspensión a medias.

## La lista, punto por punto

Un commit por punto. Tres de ellos se resuelven en otro issue, y aquí solo se anota.

| # | Hallazgo | Qué se hace |
|---|---|---|
| B1 | Faltan cabeceras de licencia fuera de `src/` y `bin/` | **Aquí.** Abajo |
| B2 | El servidor MCP, que es Apache, solo se arranca desde el CLI, que es AGPL | **En ALB-314.** Es justo la decisión del CLI que quedó pendiente allí |
| B3 | Comprobar, esperar y escribir sin volver a comprobar | **Aquí.** Abajo |
| B4 | Un topic suspendido se sigue pudiendo leer | **Aquí,** con la decisión de arriba |
| B5 | Los errores 500 van a `console.error`, sin pasar por el registro configurado | **En ALB-331,** que trae el registro estructurado y el identificador de petición |
| B6 | Un comentario de documentación encima de la función que no es | **Aquí.** Se mueve a `submitRevocation` |
| B7 | Variables sin usar y funciones `async` que no esperan nada | **Aquí.** Abajo |
| B9 | La imagen base sin fijar, y la comprobación de salud que falla con TLS | **Aquí.** Abajo |
| B10 | La versión escrita a mano en dos sitios, y sin `CHANGELOG.md` | **Aquí** la versión; el `CHANGELOG.md` lo hace quien llegue primero, este issue o ALB-348 |

### B1. Cabeceras de licencia

- Se añade `SPDX-License-Identifier` a lo que no la tiene: 14 ficheros de `test/`, los guiones de `checks/`, `examples/demo.mjs` y lo de `experiments/`. Todo ello es Apache-2.0, como dice `LICENSE`.
- `test/licenses.test.mjs` pasa a mirar también `test/`, `examples/`, `checks/` y `experiments/`: los `.mjs`, los `.sh` y los `.py`.

Sin herramienta nueva: la otra opción era adoptar REUSE, que es una dependencia más para lo mismo.

### B3. Volver a comprobar antes de escribir

En los tres sitios que señala la revisión (el registro de un agente, la publicación en un topic sobre MLS y el envío de un mensaje sobre MLS), entre la comprobación y el `store.commit` hay una espera. Lo comprobado se vuelve a mirar justo antes de escribir, como ya hace el hub en otros sitios. Hoy la ventana es mínima; el arreglo es para que no deje de serlo sin que nadie lo note.

### B4. Un topic suspendido no se lee

`GET /v1/topics/:name` y `GET /v1/topics/:name/events` contestan `403 topic_suspended`, que es el código que ya dan publicar y suscribirse. Un operador, con su clave, sigue pudiendo leerlo: tiene que poder ver lo que suspendió.

### B7. Restos

- Las variables sin usar que lista la revisión se quitan.
- Las 14 funciones `async` sin `await` se miran una a una. **Solo se cambia donde no cambia cómo falla:** una función que deja de ser `async` pasa a lanzar su error en el acto en vez de devolver una promesa rechazada, y quien la llama con `.catch` dejaría de recogerlo. En lo público del SDK se quedan como están.

### B9. La imagen

- **La imagen base, fijada por su resumen** (`node:…-alpine@sha256:…`). Dependabot, que llega con ALB-313, la mantiene al día. Qué versión de Node lleva sigue lo decidido allí.
- **La comprobación de salud** pregunta al hub en su propia máquina. Con TLS directo hoy falla siempre, porque pregunta por HTTP. Pasa a probar también por HTTPS, sin validar el certificado: se pregunta a sí misma, por la dirección local, y solo quiere saber si el hub contesta.

### B10. La versión

El hub y el servidor MCP leen su versión del `package.json` de su paquete, en vez de llevarla escrita. El test que hoy vigila que las dos copias coincidan se queda comprobando que cada uno dice la de su paquete.

## Tests

1. **B1:** `test/licenses.test.mjs`, ampliado: ningún fichero de esas carpetas sin su cabecera.
2. **B3:** en cada uno de los tres sitios, lo que cambia durante la espera (el agente se retira, el grupo cambia) hace que no se escriba nada.
3. **B4:** la ficha y el historial de un topic suspendido dan `403 topic_suspended`, para un agente cualquiera, para un suscriptor y para su dueño; un operador los lee; al readmitirlo vuelven a leerse.
4. **B7:** los tests de siempre, sin tocarlos.
5. **B9:** `checks/self-hosted.sh` comprueba que el contenedor queda sano, y `checks/tour.sh`, que ya arranca un hub con TLS directo, que su comprobación de salud contesta bien.
6. **B10:** el hub y el servidor MCP dicen la versión de su `package.json`.

## Documentación

- `README.md`: que un topic suspendido no se lee. Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva, con la tabla.
- **En el issue de Linear:** cada punto, hecho o remitido a su issue.

## Comprobación

- `npm test`, `bash checks/all.sh` y `checks/self-hosted.sh`.

## Fuera de este issue

- **B2, B5 y B8,** en ALB-314, ALB-331 y ALB-313.
- **Un linter** que encuentre los restos de B7 de ahora en adelante: descartado en ALB-313.
