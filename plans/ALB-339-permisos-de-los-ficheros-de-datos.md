# ALB-339 · Hub: los ficheros de datos y las copias de seguridad se crean con los permisos por defecto

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-339
- **Rama:** `info/alb-339-seguridadlow-hub-los-ficheros-de-datos-y-las`
- **Prioridad:** Low (seguridad)
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.
- **Va después de ALB-327 y ALB-316,** que añaden ficheros al directorio de datos (`lock`, `log.jsonl`).

## El problema

La clave del hub se guarda con permisos `0600`, pero su estado no: el diario y el snapshot se escriben con los permisos por defecto del proceso, que suelen dejar leer a cualquier usuario de la máquina.

No hay claves ahí. Pero sí quién está registrado, qué topics hay, las instancias de cada agente y los mensajes cifrados que esperan en los buzones: quién habla con quién.

## Lo que se propone

Lo que dice el issue, sin decisiones nuevas.

## Cambios

### 1. El almacén (`src/hub/store.mjs`)

- **Cada fichero que escribe, con `0600`:** el diario, el snapshot y su temporal, y los que añaden otros planes (el registro en su fichero y el candado).
- **El directorio de datos, con `0700`** cuando lo crea el hub.
- **Si el directorio ya existía y está más abierto,** el hub no lo cambia por su cuenta: puede ser un volumen montado a propósito. Se lo dice a su operador en una línea al arrancar.
- **Los ficheros que ya existían,** de una versión anterior, se cierran a `0600` al cargar.

### 2. Las copias (`deploy/self-hosted/backup.sh`)

`umask 077` al principio. El guion ya cierra el directorio de la copia; así lo que copia dentro nace cerrado también.

### 3. Windows

Ese sistema no tiene estos permisos. El hub no falla ahí; simplemente no puede dar esta garantía, y se dice en el README, como el resto de lo que ALB-313 encuentre en Windows.

## Tests

En `test/store.test.mjs`, solo donde existen estos permisos:

1. **Cada fichero del directorio de datos tiene `0600`,** después de arrancar, de escribir y de compactar. El test recorre el directorio entero: un fichero nuevo que alguien añada sin cerrar lo hace fallar.
2. **Un directorio creado por el hub tiene `0700`.**
3. **Uno que ya existía más abierto** no se toca, y sale el aviso.
4. **Ficheros de antes, con `0644`,** quedan en `0600` al cargar.

En `checks/backup.sh`:

5. **Lo copiado no lo puede leer otro usuario.**

## Documentación

- `docs/SELF-HOSTING.md`: los permisos del directorio de datos y de las copias, y qué hacer si el hub avisa de que está abierto.
- `README.md` y `CLAUDE.md`: número de tests.
- `docs/HANDOFF.md`: sección nueva, corta.

## Comprobación

- `npm test` en verde antes y después.
- `bash checks/all.sh` y `checks/self-hosted.sh`: con Docker el directorio es un volumen del usuario del contenedor, y se confirma que el hub sigue pudiendo escribir en él.

## Fuera de este issue

- **Los datos del testigo y del verificador:** sus claves ya van con `0600`.
- **Cifrar el estado en disco.** Lo que hay en los buzones ya va cifrado de extremo a extremo; el resto es el directorio, que el hub enseña a quien se lo pide.
