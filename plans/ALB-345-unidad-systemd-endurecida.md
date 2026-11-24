# ALB-345 · Despliegue: la unidad de systemd del hub no tiene opciones de endurecimiento

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-345
- **Rama:** `info/alb-345-seguridadlow-deploy-la-unidad-systemd-del-hub`
- **Prioridad:** Low (seguridad)
- **Estado:** plan del 24 de noviembre de 2026. Nada implementado.

## El problema

La unidad de ejemplo (`deploy/self-hosted/agenthub.service`) arranca el hub con un usuario propio, pero le deja más acceso al sistema del que necesita. Si alguien llegara a tomar el proceso del hub, se encontraría con más de la cuenta. Es defensa en profundidad: no arregla un fallo, limita el daño de uno.

## Lo que hay hoy, mirado en el fichero

El issue dice que la unidad no tiene ninguna de estas opciones. Tiene tres:

| Opción | Hoy |
|---|---|
| `NoNewPrivileges` | Está |
| `ProtectSystem=strict` | Está |
| `ReadWritePaths` con el directorio de datos | Está |
| Las demás de la lista del issue | Faltan |

## Lo que se propone

Añadir las que faltan, sin decisiones nuevas, y **comprobar que el hub sigue arrancando**, que es la mitad del trabajo: una opción de más y el servicio no levanta.

## Cambios

En `deploy/self-hosted/agenthub.service` (que se llamará como deje ALB-346).

### 1. Las opciones que faltan

| Opción | Qué quita |
|---|---|
| `ProtectHome=yes` | Ver los directorios de los usuarios |
| `PrivateTmp=yes`, `PrivateDevices=yes` | El `/tmp` común y los dispositivos |
| `ProtectKernelTunables`, `ProtectKernelModules`, `ProtectControlGroups` | Tocar el núcleo y los grupos de control |
| `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` | Otros tipos de conexión |
| `RestrictNamespaces=yes`, `LockPersonality=yes` | Crear espacios de nombres y cambiar de personalidad |
| `CapabilityBoundingSet=` | Todas las capacidades. El hub escucha en el 8787, detrás de un proxy: no necesita ninguna, ni la de abrir puertos bajos que propone el issue |
| `UMask=0077` | Que lo que escriba nazca legible para otros. Va con ALB-339 |

### 2. Lo que se deja como está, con su porqué escrito en el fichero

- **`MemoryDenyWriteExecute`** no se activa: el motor de JavaScript genera código en marcha y lo necesita.
- **Si Node está instalado en el directorio de un usuario** (con un gestor de versiones), `ProtectHome` impide arrancar. La unidad usa `/usr/bin/node`; el comentario lo avisa.

## Tests

Una unidad de systemd no se puede probar en `npm test`. Se comprueba con un guion nuevo, `checks/systemd.sh`, que corre solo donde systemd es quien manda en la máquina, como los ejecutores de la CI:

1. **`systemd-analyze verify`:** la unidad no tiene errores.
2. **El hub arranca de verdad con ella,** contesta en `/healthz`, acepta un registro y escribe en su directorio de datos.
3. **Para y vuelve a arrancar** con lo que tenía.
4. **No puede escribir fuera** de su directorio de datos.
5. **`systemd-analyze security`:** la puntuación, antes y después, anotada en el HANDOFF. Sin umbral en el guion: la puntuación cambia con la versión de systemd.

Entra en la CI como un paso del job que ya prueba la imagen y los ficheros de `deploy/`. No entra en `all.sh`, que tiene que poder pasar en cualquier máquina.

## Documentación

- `docs/SELF-HOSTING.md`: lo que la unidad le quita al hub, y qué tocar si alguien lo necesita de otra forma (otro directorio de datos, Node en otro sitio).
- `checks/README.md`: el guion nuevo, qué comprueba y qué necesita.
- `docs/HANDOFF.md`: sección nueva, corta, con la puntuación.

## Comprobación

- `checks/systemd.sh` en la CI.
- `npm test` no cambia.

## Fuera de este issue

- **Lo mismo para el contenedor** (usuario sin privilegios ya lo tiene; sistema de ficheros de solo lectura, capacidades): no está en el issue.
- **Unidades para el testigo y el verificador:** hoy no hay ninguna.
