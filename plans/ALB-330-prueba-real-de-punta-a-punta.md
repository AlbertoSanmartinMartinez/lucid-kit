# ALB-330 · Prueba real de punta a punta: TLS en un dominio, `did:web`, verificador de GitHub y dos hubs en dos máquinas

- **Issue:** https://linear.app/alberto-sanmartin-martinez/issue/ALB-330
- **Rama:** `info/alb-330-prueba-real-de-punta-a-punta-hub-con-tls-en-un`
- **Prioridad:** High
- **Estado:** plan acordado el 24 de noviembre de 2026. Nada desplegado ni implementado.

## Antes de este issue

| Issue | Por qué va antes |
|---|---|
| ALB-327, con ALB-301 y ALB-302 | El hub que se despliega no debe llevar los fallos del almacén |
| ALB-304 | Se prueba el emparejamiento abierto, y es aquí donde su camino de red se ejercita por primera vez |

## El problema

Tres piezas están escritas y probadas solo con dobles. Nunca han corrido contra el mundo real:

1. **`did:web`:** la resolución por HTTPS de verdad. Los tests inyectan el documento.
2. **El verificador de GitHub:** nunca ha hablado con GitHub.
3. **La federación:** solo dos procesos en la misma máquina, sin TLS.

Son lo que se enseña en una demo. Sin esta prueba, el primer fallo sale delante de un cliente.

## Decisiones del dueño

| Pregunta | Decisión |
|---|---|
| Dónde se monta | **Instancias pequeñas en Scaleway, DigitalOcean y OVHcloud.** Tres proveedores: la federación cruza redes de verdad distintas |
| Qué nombres | **Subdominios de prueba de `uselucid.org`.** No tocan la landing |
| Qué pasa al acabar | **Se desmonta todo.** Un entorno público permanente es ALB-349 |

## Lo que se monta

| Máquina | Proveedor | Nombre | Qué corre |
|---|---|---|---|
| A | Scaleway | `hub-a.test.uselucid.org` | Hub A, con `deploy/self-hosted/` tal cual (Docker Compose y Caddy) |
| B | DigitalOcean | `hub-b.test.uselucid.org` | Hub B, igual |
| C | OVHcloud | `verify.test.uselucid.org` y `org.test.uselucid.org` | El verificador detrás de Caddy, y el `did.json` servido por Caddy |

Qué proveedor lleva cada cosa da igual; se reparte así para tener un hub en cada lado.

Los hubs se montan siguiendo `docs/SELF-HOSTING.md` al pie de la letra, desde un commit de `main` que se anota. Así la guía se prueba también en una máquina de verdad: cada paso que no funcione como está escrito es un hallazgo.

## Quién hace qué

**El dueño**, porque son cuentas, dinero y acciones de fuera:

1. Las tres instancias, con Docker, y su cortafuegos: solo 22, 80 y 443.
2. Los cuatro registros DNS.
3. Una app OAuth de GitHub de prueba, con el flujo de dispositivo activado. Su identificador de cliente no es un secreto.
4. Meter el código de dispositivo en GitHub cuando el guion lo pida.

**El guion**, `checks/real.sh`, desde un ordenador cualquiera: todo lo que hace un agente o un controlador, con el CLI, como los demás guiones de `checks/`.

## Ficheros nuevos

- **`checks/real.sh`:** el recorrido, parametrizado con variables de entorno (las direcciones de los dos hubs, la del verificador, el dominio del `did:web`). Sale con 0 solo si todo pasó, y dice cuánto tardó cada paso. No entra en `all.sh` ni en la CI: necesita el mundo de fuera.
- **`checks/real/`:** el `docker-compose.yml` y el `Caddyfile` de la máquina C. `deploy/self-hosted/` no cubre el verificador; hacerlo desplegable de verdad es ALB-331.
- **`checks/README.md`:** qué comprueba, qué necesita y cómo se lanza.

## El recorrido

**1. Los hubs por HTTPS.** `/v1/info` de cada uno, con el certificado que Caddy obtuvo solo y validado con las autoridades del sistema. La dirección que anuncia cada hub es la suya.

**2. `did:web` contra el dominio real.**
- `controller init` y `controller did-web --domain org.test.uselucid.org`. El guion enseña el documento y espera a que esté en `https://org.test.uselucid.org/.well-known/did.json`.
- `controller delegate … --domain …`, y el agente se registra en el hub A: el hub resuelve el dominio de verdad y el agente queda en nivel `org`.
- `controller revoke`: el agente queda fuera en el acto, y la delegación revocada se rechaza al presentarla otra vez.
- Casos que deben fallar: un dominio sin documento, y uno cuyo documento nombra otra clave.

**3. El verificador contra GitHub.**
- El verificador arranca en C con el identificador de la app, su dirección pública y detrás de un proxy.
- `controller verify --verifier … --submit`: el guion enseña el código, el dueño lo mete en GitHub y la atestación sale.
- El hub A, arrancado con `--trust-verifier`, la acepta: el agente delegado por ese controlador pasa a nivel `account`.
- Se anota lo que GitHub contesta sobre sus límites de tasa, y cuánto tarda el ciclo.

**4. Federación entre dos máquinas, con TLS en los dos lados.**
- Los dos operadores se emparejan (`--peer` en cada hub) y cada hub dice que el emparejamiento vale.
- **Topics:** un agente de A sigue y publica en `topic@hub-b`, y al revés.
- **Mensajes directos:** un agente de A escribe a `did@hub-b` sobre MLS, y al revés, con una renovación de claves en medio y una lectura después de reconectar.

**5. Emparejamiento abierto.**
- A se reinicia con `--open-pairing` y sin nombrar a B. B lo nombra y se empareja solo.
- Un topic y un mensaje directo vuelven a cruzar.
- Un tercer nombre de prueba que resuelve a una dirección privada se rechaza al emparejar.

## Qué se anota, y dónde

- **En el issue de Linear:** resultado de cada paso, tiempos y fallos.
- **Cada fallo, en su propio issue.**
- **En `README.md`:** las líneas de «sin comprobar» de `did:web`, del verificador y de la federación pasan a decir qué se comprobó, contra qué y qué día. Lo que siga sin comprobar se queda dicho.
- **En `docs/HANDOFF.md`:** sección nueva con lo hecho, el commit desplegado y lo encontrado.

## Al acabar

1. Borrar las tres instancias, en los tres proveedores.
2. Borrar los cuatro registros DNS.
3. Borrar la app OAuth de prueba.
4. Las claves de prueba (hubs, controlador, agentes, verificador) se descartan con las máquinas. No se reutilizan.

## Criterios de aceptación

- [ ] La delegación `did:web` contra el dominio real se acepta, y la revocada se rechaza.
- [ ] Hay una atestación de GitHub real, emitida y aceptada por un hub.
- [ ] La federación entre dos máquinas con TLS funciona en topics y en mensajes directos.
- [ ] El emparejamiento abierto funciona por HTTPS contra una dirección pública.
- [ ] Los fallos encontrados están abiertos como issues aparte.
- [ ] No queda nada desplegado.

## Fuera de este issue

- **Un hub público permanente:** ALB-349.
- **El verificador listo para producción** (TLS propio, logs, copia del secreto): ALB-331.
- **Resolver `did:web` por defecto en el SDK y sus claves P-256:** ALB-333.
- **Carga y volumen.** Aquí se prueba que funciona, no cuánto aguanta.
