# ALB-310 · Tests: esperas fijas y dependencia del reloj real

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-310
- **Rama:** `info/alb-310-tests-esperas-fijas-y-dependencia-del-reloj`
- **Prioridad:** Low
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.

## El problema

Algunos tests dependen del reloj de verdad. No ha fallado ninguno en las pasadas de QA: es un riesgo, no un fallo visto. Pero son los tests que fallan un día en una máquina cargada, sin que nada esté roto.

| Tipo | Dónde | Qué puede pasar |
|---|---|---|
| Caducidades con poco margen | `instances` (un certificado de 1.200 ms y una espera de 1.300), `attestations` (1.500 y 1.600), `witness` (esperas de 1.100 y 2.100 ms) | Si lo de antes tarda más de la cuenta, el primer paso ya falla |
| Esperar para ver que algo **no** pasa | `federation` (150 y 250 ms) | Un verde falso: quizá iba a pasar a los 300 ms |
| `deadHubUrl()` | `test/helpers.mjs` | Abre un puerto, lo cierra y lo devuelve: otro proceso puede ocuparlo entre medias |

## Lo que se propone

Sin tocar el producto. El issue pide un reloj inyectado, y el hub lee la hora en 31 sitios: pasarles un reloj a todos sería un cambio grande para arreglar tests.

En su lugar, **el reloj de mentira del propio corredor de tests de Node**, solo para la fecha (`t.mock.timers`, con `apis: ['Date']`). Los hubs de prueba corren en el mismo proceso que el test, así que el hub, el SDK y el test ven la misma hora, y el test la adelanta cuando quiere. Los temporizadores de verdad no se tocan: la red y los streams siguen funcionando igual.

## Cambios

Todos en `test/`.

### 1. Caducidades: adelantar el reloj en vez de esperar

En `instances`, `attestations` y `witness`: el test fija la hora, hace lo suyo, **adelanta la hora** más allá de la caducidad y comprueba. Desaparecen las esperas de uno y dos segundos, y con ellas el margen.

Los certificados y las atestaciones de esos tests pueden volver a durar lo que durarían de verdad (días), en vez de un segundo y pico.

### 2. Lo que no debe pasar: esperar a algo que sí pasa

En `federation`: en vez de esperar 150 ms para ver que un evento no llegó, el test espera a un hecho que marca que ya no puede llegar. Por ejemplo, que la petición bloqueada alcanzó al otro hub (el `fetch` que se le da al hub de prueba lo avisa), o que llegó un evento posterior, mandado después, que por orden tendría que ir detrás.

### 3. `deadHubUrl()`

Devuelve `http://127.0.0.1:1`: un puerto reservado, en el que nada escucha y que nadie va a ocupar. Sigue dando «conexión rechazada», que es lo que los tests que la usan comprueban. Deja de ser asíncrona; quien la llama con `await` no nota nada.

### 4. Repaso del resto

Hay 21 esperas con `setTimeout` en los tests. Se repasan todas con la misma pregunta: ¿espera a un tiempo o a un hecho? Las que esperan a un tiempo sin necesidad se cambian; las que tienen que ser de tiempo de verdad (un plazo de red, por ejemplo) se quedan, con un comentario que lo dice.

## Tests

Son los mismos tests, que siguen comprobando lo mismo. Lo que se mira es que:

1. **Ninguno pierde fuerza:** cada test tocado se comprueba quitando la defensa que vigila y viéndolo fallar. Un test que deja de esperar y deja también de cazar es peor que el de antes.
2. **La suite no tarda más,** y debería tardar algo menos.

## Comprobación

- `npm test` en verde en las versiones de Node de la CI.
- **Bajo carga:** la suite con la CPU saturada y con mucha concurrencia, como hizo QA, diez veces seguidas sin un fallo.
- `bash checks/all.sh`: no cambia, sus procesos son de verdad y usan el reloj de verdad.

## Documentación

- `CLAUDE.md`, regla «Tests que se cuelgan»: un test nuevo no espera a que pase el tiempo; adelanta el reloj, o espera a un hecho.
- `docs/HANDOFF.md`: sección nueva, corta.

## Fuera de este issue

- **Un reloj inyectable en el hub y en el SDK.** Si un día hace falta en producción (para simular, por ejemplo), es otro cambio.
- **Los guiones de `checks/`,** que esperan a procesos de verdad con sus propios plazos.
