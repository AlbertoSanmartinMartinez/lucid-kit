# ALB-335 · Federación ampliada: primero, la rotación de la clave del hub

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-335
- **Rama:** `info/alb-335-federacion-ampliada-topics-privados-y`
- **Prioridad:** Low
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada diseñado ni implementado.
- **Va después de ALB-330:** antes de ampliar la federación hay que haberla probado entre máquinas de verdad.

## El problema

La federación hace lo que promete, y nada más: topics públicos y mensajes directos entre hubs emparejados a mano. El issue lista lo que no hay. Lo más urgente es lo que hoy no tiene salida:

**Un hub no puede cambiar de clave.** Si se la roban, hay que rehacer a mano todos los emparejamientos, y para quien sigue su registro de transparencia es otro hub: no hay forma de distinguirlo de uno que reescribe su historia.

## Decisión del dueño

**Solo la rotación de la clave del hub, por ahora.** El issue fija que va primero. El resto queda listado y sin orden hasta que lo pida un cliente.

## Lo que se propone

Dos pasos: **primero el diseño, escrito y aprobado; después el código.** Es criptografía y protocolo: la regla del proyecto es no inventar una construcción sin dejar dicho qué garantiza y qué no.

El punto de partida es no inventar nada: **hacer con el hub lo que ya se hace con un agente.** Un agente es su clave y no la cambia: pasa a ser otro, su sucesor, y eso queda firmado y apuntado (sección 33 de `docs/HANDOFF.md`). Lo que allí se decidió vale aquí por los mismos motivos:

| Regla del relevo de un agente | Lo mismo, para un hub |
|---|---|
| Lo firma un guardián nombrado antes, o el propio agente si no nombró ninguno | Una clave de guardián del hub, que su operador guarda fuera de la máquina |
| El sucesor firma que lo acepta | La clave nueva del hub lo firma |
| A uno retirado solo lo releva un guardián nombrado antes: la clave que firmaría puede ser ya de cualquiera | Es el caso que importa: una clave robada. Sin guardián nombrado antes, quien la robó puede relevarse a sí mismo |
| Se releva una vez, y nadie releva a dos | Igual |

## Lo que el diseño tiene que resolver

La clave de un hub está en más sitios que la de un agente. Cada fila es una pregunta que el diseño contesta antes de escribir código:

| Dónde está hoy la clave del hub | La pregunta |
|---|---|
| El emparejamiento (`NOMBRE=URL#DID`) | Cómo acepta un par el relevo sin que su operador toque nada, que es lo que pide el issue. Y qué pasa con uno que estuvo apagado mientras tanto |
| Lo que firma cada agente «para este hub»: sus peticiones, sus declaraciones y sus eventos | Qué pasa con lo firmado para la clave vieja: qué sigue valiendo y hasta cuándo |
| El registro de transparencia, cuyo origen es el DID del hub | Si el registro sigue siendo el mismo con otra clave que lo firma, o es uno nuevo. Para quien lo sigue, lo primero es lo único que no parece un hub que reescribe su historia |
| Los testigos, que cofirman una lista por origen | Cómo sabe un testigo que la clave nueva es la del mismo registro, sin fiarse de lo que el hub diga de sí mismo |
| Las conversaciones entre hubs, que tienen una casa | Si el relevo cambia qué hub es la casa de una conversación, que hoy se decide por el orden de los DID |
| Lo que cada hub guarda de un par, por su clave | Cómo pasa al sucesor, y qué no pasa |

Y lo que no puede aflojarse, tal como ya está escrito para los agentes: es lo que impide a quien roba una clave quedarse con el hub.

## El entregable del primer paso

Una sección nueva de `docs/HANDOFF.md`, que es donde este proyecto guarda sus decisiones de diseño: las preguntas de arriba con su respuesta, lo que la construcción garantiza y lo que no, y las decisiones que sean del dueño, señaladas. Con eso aprobado se escribe el plan del código, que será un issue propio.

## Lo que traerá el código, en grande

Para que se vea el tamaño, sin adelantar el diseño:

- Declaraciones nuevas, con su contexto de firma propio.
- Tipos de entrada nuevos en el registro, con sus reglas.
- El hub que releva y los pares que lo aceptan.
- El SDK y los testigos, que siguen el relevo.
- Sus tests, con los casos de ataque (una clave robada que intenta relevarse, dos sucesores, un relevo repetido), sus mutaciones, y una comprobación con dos hubs de verdad en dos máquinas, como pide el issue.

## Lo demás del issue: listado y sin orden

Se retoma cuando un cliente lo pida, cada cosa con su diseño:

- Topics privados y restringidos entre hubs.
- Descubrimiento de hubs.
- El relevo de un agente a través de hubs, y los bloqueos que siguen al sucesor.
- Que el registro cubra lo que llega de otros hubs.
- La rotación de la clave de un controlador.

## Fuera de este issue

- **Comprobar la versión del protocolo entre hubs:** ALB-308.
- **El emparejamiento abierto y sus direcciones:** ALB-304.
