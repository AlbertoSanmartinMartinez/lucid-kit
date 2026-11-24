# ALB-356 · Lista de espera con formulario de HubSpot en uselucid.org

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-356
- **Rama:** `info/alb-356-lista-de-espera-con-formulario-hubspot-en`
- **Prioridad:** Low
- **Estado:** decidido el 24 de noviembre de 2026: **ahora no.** Nada cambiado.

## El problema

El contacto de la web es un enlace de correo. No hay forma de contar cuánta gente se interesa, ni de saber de dónde llega cada petición.

## Decisión del dueño

**Ahora no.** Se queda el correo de contacto. Este plan deja escrito cómo se haría, para cuando medir el interés haga falta de verdad.

## Por qué tiene sentido esperar

- **No hay todavía a qué apuntarse.** La lista de espera es para el servicio alojado, que se construye después y en otro repositorio.
- **La web hoy no carga nada de nadie.** Es HTML estático, sin dependencias, sin analítica y sin cookies. Un formulario mal puesto cambia eso, y con ello obliga a avisos y textos legales que hoy no hacen falta.

## Cómo se haría, cuando toque

### La forma recomendada: un formulario propio que envía a HubSpot

Un formulario HTML de la propia página, con su estilo, que manda los datos a HubSpot directamente. **Sin cargar el script de HubSpot:** no entran en la web ni código ni cookies de terceros, y sigue siendo estática.

La otra forma, incrustar el formulario de HubSpot con su script, es más rápida de montar y trae todas sus funciones. A cambio mete código y cookies de un tercero, y con ellos un aviso de cookies.

### Lo que habría que tener antes

| Qué | Quién |
|---|---|
| El formulario creado en HubSpot, con sus campos: el correo, y poco más | El dueño |
| Un texto de consentimiento y una nota de privacidad: qué se guarda, para qué, y cómo darse de baja | El dueño, con Legal. Recoger correos de personas lo exige |
| Cómo se distingue en HubSpot lo que llega de LUCID | Una propiedad del contacto. Importa más desde que LUCID es independiente de Moflet (ALB-347): sus contactos no deben mezclarse con los de Moflet |

### Lo que cambiaría en el repositorio

- **`site/index.html` y `site/es/index.html`:** el formulario, en las dos lenguas, junto al enlace de correo o en su lugar.
- **Sin JavaScript, funciona:** el formulario se envía como cualquier formulario. Con JavaScript, la página puede decir «apuntado» sin salir de ella.
- **`test/site.test.mjs`:** las dos páginas llevan el mismo formulario, apunta a HubSpot y a ningún otro sitio, y la página sigue sin cargar scripts de fuera.
- **Una prueba a mano:** un alta de prueba que se ve llegar a HubSpot, y que se borra después.

## Los criterios del issue

Los tres quedan abiertos, a propósito:

- [ ] uselucid.org tiene un formulario de lista de espera.
- [ ] Las altas quedan registradas de forma que se pueda medir el interés.
- [ ] El contacto de empresa se puede atribuir a LUCID en HubSpot.

## Qué lo reabriría

Cualquiera de estas dos cosas:

- **Una fecha para el servicio alojado,** que es a lo que alguien se apuntaría.
- **Necesitar el número:** tener que decidir algo, o enseñárselo a alguien, que dependa de cuánta gente se interesa.

## Fuera de este issue

- **Analítica de la landing.**
- **Los textos de la web:** ALB-350 y ALB-347.
