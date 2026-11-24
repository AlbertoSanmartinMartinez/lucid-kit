# ALB-322 · Cuotas: la cuota diaria se cobra antes de validar el envío, y también en los duplicados

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-322
- **Rama:** `info/alb-322-m7-cuotas-la-cuota-diaria-se-cobra-antes-de`
- **Prioridad:** Medium
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.

## El problema

El hub cobra un envío de la cuota diaria (`chargeSend`) nada más empezar a atenderlo, antes de comprobar nada. Lo hace en tres sitios: publicar en un topic, mandar un mensaje directo y publicar en un topic de otro hub.

Así se cobra también:

- **Un envío que el hub rechaza:** no cumple el esquema, o llega para una época o un grupo que ya no es el actual.
- **Un reintento del mismo envío,** con el mismo `id`, que el hub reconoce como repetido.

El SDK reintenta solo cuando el hub dice que la época o el grupo cambiaron: un único mensaje se cobra dos veces. En el servicio alojado la cuota es lo que se vende y lo que el usuario ve en `GET /v1/usage`.

## Lo que se propone

La regla: **se cobra lo que el hub acepta, una vez.** Lo rechazado y lo repetido no se cobran. Quien manda mucho inválido ya tiene su freno, que es el límite por minuto.

## Cambios

Todos en `src/hub/server.mjs`.

### 1. Topics y mensajes directos de este hub

`chargeSend` baja hasta justo antes de `store.commit`, después de validar y de mirar si el envío es repetido. Entre un punto y otro no hay ninguna espera, así que mirar el cupo y gastarlo siguen siendo un solo paso.

### 2. Un mensaje a quien te tiene bloqueado se cobra

El hub acepta ese mensaje y lo descarta sin decírselo a quien lo manda. Si no se cobrara, el bloqueado lo vería en su cuenta de uso: el número no se movería. Se cobra antes de mirar el bloqueo.

### 3. Publicar en un topic de otro hub

Aquí sí hay una espera, la respuesta del otro hub:

- **Antes de preguntarle** se mira si queda cupo, sin gastarlo. Sin cupo, `429` como hoy, y el otro hub no llega a enterarse.
- **Se cobra cuando el otro hub lo acepta** y no dice que es repetido. Si no contesta, o lo rechaza, no se cobra.

Varios envíos a la vez de la misma cuenta podrían pasar del cupo en lo que tarda el otro hub en contestar; lo acota el límite por minuto, y se acepta.

### 4. Lo que no cambia

El código del error (`quota_exceeded`), cuándo se pone a cero y que la cuenta vive en memoria.

## Tests

En `test/quotas.test.mjs`, mirando `GET /v1/usage` antes y después:

1. **Un evento que no cumple el esquema** no gasta cuota.
2. **El mismo envío dos veces:** se cobra una.
3. **Un mensaje sobre MLS que el hub rechaza por época o grupo viejo,** y que el SDK reintenta solo: un mensaje, un cobro.
4. **Un mensaje a quien tiene bloqueado al remitente** se cobra, igual que uno entregado.
5. **Con el cupo agotado,** un envío nuevo recibe `429`; repetir uno ya aceptado sigue contestando que es repetido, no `429`.
6. **A un topic de otro hub:** se cobra si el otro hub lo acepta; no se cobra si no contesta, si lo rechaza o si dice que es repetido. Sin cupo, el otro hub no recibe nada.
7. **Quien manda mucho inválido** sigue topándose con el límite por minuto.

## Documentación

- `README.md`, donde habla de cuotas: qué cuenta como un envío. Número de tests, ahí y en `CLAUDE.md`.
- `docs/HANDOFF.md`: sección nueva, con el porqué de cobrar el mensaje bloqueado.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh`: `tour.sh` arranca un hub con tres envíos al día y comprueba el cuarto.

## Fuera de este issue

- **El coste por petición de calcular las cuotas:** ALB-323.
- **Que la cuenta de uso sobreviva a un reinicio:** hoy empieza de cero, y está dicho en `src/hub/quota.mjs`.
