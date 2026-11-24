# ALB-352 · Infraestructura de comunidad: DCO, `SECURITY.md` y `CONTRIBUTING.md`

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-352
- **Rama:** `info/alb-352-infraestructura-de-comunidad-cla-o-dco`
- **Prioridad:** Medium
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada escrito.

## El problema

El repositorio es público y no dice cómo contribuir, cómo avisar de un fallo de seguridad ni qué se espera de quien participa. No hay `CONTRIBUTING`, `SECURITY.md` ni `CODE_OF_CONDUCT`.

Dos cosas no pueden esperar a que llegue alguien:

- **Qué firma quien contribuye.** Hay que tenerlo decidido antes de aceptar la primera aportación de fuera, no después.
- **`SECURITY.md`.** En un proyecto de criptografía, quien encuentra un fallo tiene que saber dónde contarlo en privado.

## Decisiones del dueño

| Pregunta | Decisión |
|---|---|
| CLA o DCO | **DCO.** Quien contribuye certifica en cada commit (`Signed-off-by`) que puede aportar ese código. Sin papeleo |
| Canal para avisar de un fallo de seguridad | **Los dos:** el aviso privado de GitHub como vía principal, y un correo del proyecto para quien no use GitHub |

**Lo que el DCO cierra, y se deja escrito:** el código AGPL que llegue de fuera ya no se podrá ofrecer con otra licencia. El hub será AGPL para todos, también para el proyecto. El issue pide que la decisión la tome el dueño con Legal: aquí queda tomada por el dueño, y la revisión de Legal sigue pendiente, junto con la de las licencias (ALB-354).

## Ficheros nuevos

Todos en inglés: son para quien llega de fuera, como el README (ALB-348).

### `SECURITY.md`

- **Cómo avisar:** el aviso privado de GitHub en este repositorio, o el correo de seguridad del proyecto. Nunca en un issue público.
- **Qué contar:** la versión, qué pasa y cómo reproducirlo.
- **Qué esperar.** Plazos que una sola persona puede cumplir; son una propuesta, y el dueño los ajusta a lo que pueda sostener:

  | Paso | Plazo |
  |---|---|
  | Acuse de recibo | 3 días laborables |
  | Primera valoración | 10 días laborables |
  | Publicación coordinada | Hasta 90 días, o antes si hay arreglo |

- **Qué versiones reciben arreglos:** la última publicada.
- **Qué entra:** el protocolo, el hub, el SDK, el servidor MCP, el testigo y el verificador. Un hub que opera otra persona se avisa a quien lo opera.
- **El estado real:** el proyecto no ha pasado una auditoría externa (ALB-336). Se dice.

### `CONTRIBUTING.md`

- **El DCO:** qué certifica quien firma, y cómo se firma (`git commit -s`).
- **Las licencias:** lo que se aporta al lado cliente va bajo Apache-2.0 y lo que se aporta al hub, bajo AGPL-3.0-only. Cada fichero lleva su cabecera.
- **Cómo se trabaja,** en corto y remitiendo a lo que ya está escrito: tests en verde antes y después, cada cambio de comportamiento con sus tests y sus casos de ataque, cambios pequeños y completos.
- **Antes de un cambio grande, un issue.** Y los fallos de seguridad, por `SECURITY.md`.

### `CODE_OF_CONDUCT.md`

El Contributor Covenant, en su versión vigente y sin cambios, con el correo del proyecto como contacto.

### En `.github/`

- **Una comprobación del DCO** en los pull requests: cada commit lleva su `Signed-off-by`. Unas líneas de `bash` sobre los commits del pull request, con las acciones fijadas por SHA; sin una aplicación de terceros.
- **Plantillas de issue:** un fallo, una propuesta, y un aviso que manda los fallos de seguridad a `SECURITY.md`.
- **Una plantilla de pull request** corta: qué cambia, qué tests lleva y el recordatorio de la firma.

## Lo que hace el dueño

Son ajustes de fuera del código:

1. **Activar el aviso privado de vulnerabilidades** en los ajustes del repositorio.
2. **Crear el correo de seguridad** en el dominio del proyecto, y leerlo.
3. **Decidir si se activan las Discussions.** El plan no las necesita.
4. **Llevar a Legal** el DCO y el reparto de licencias.

Hasta que 1 y 2 estén hechos, `SECURITY.md` no se publica: prometería un canal que no existe.

## Tests

En `test/package.test.mjs`:

1. **Los tres ficheros existen,** y `SECURITY.md` nombra los dos canales.
2. **No viajan en los paquetes de npm** más que la licencia y el README de cada uno.
3. **La comprobación del DCO** tiene sus acciones fijadas por SHA, como el resto de workflows (ALB-313).

La comprobación del DCO se prueba de verdad con un pull request de prueba: un commit sin firma la pone en rojo, y uno firmado, en verde.

## Documentación

- `README.md`: enlaces a los tres ficheros.
- `CLAUDE.md`: que estos ficheros van en inglés, y que los commits del proyecto llevan `Signed-off-by`.
- `docs/HANDOFF.md`: sección nueva con las dos decisiones y lo que el DCO cierra.

## Comprobación

- `npm test`.
- Un aviso de seguridad de prueba por cada canal, para ver que llega.

## Fuera de este issue

- **Un CLA.** Descartado. Si algún día hiciera falta relicenciar, habría que pedir permiso a cada contribuidor del código afectado.
- **Auditoría externa y programa de recompensas:** ALB-336.
- **La frase sobre la licencia MIT en `LICENSE`:** ALB-354.
