# Compatibilidad entre ts-mls y OpenMLS

Experimento del 13 de noviembre de 2026. No forma parte del producto ni de `npm test`.

**Qué responde.** Si se puede empezar MLS con `ts-mls` (TypeScript) y pasar más adelante a OpenMLS (Rust) sin cambiar el protocolo. Para eso las dos librerías tienen que entenderse dentro de un mismo grupo.

**Resultado.** Se entienden: 20 comprobaciones de 20, con `ts-mls` 1.6.4 y OpenMLS 0.9.2, en la suite `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`.

| Grupo creado por | Qué se comprobó |
|---|---|
| `ts-mls` | OpenMLS entra con su KeyPackage y el Welcome de `ts-mls`. Mensajes en los dos sentidos. Cada lado procesa un commit del otro. `ts-mls` añade a un tercer miembro y OpenMLS lo expulsa; el expulsado no lee la época siguiente. |
| OpenMLS | `ts-mls` entra con su KeyPackage y el Welcome de OpenMLS, tomando el árbol de la extensión `ratchet_tree`. Mensajes en los dos sentidos. Cada lado procesa un commit del otro. |

**Qué no prueba.** Solo esa suite, solo credenciales básicas y solo commits y mensajes cifrados (`PrivateMessage`). No cubre propuestas sueltas, commits externos, claves precompartidas, reinicios de grupo ni las suites poscuánticas. Tampoco dice nada sobre la seguridad de ninguna de las dos librerías: `ts-mls` no tiene auditoría.

**Cómo repetirlo.** Hacen falta Rust y Node 20 o superior.

```bash
cd experiments/mls-interop
(cd openmls-member && cargo build --release)
npm install
npm run interop
```

Cada lado solo ve bytes del otro. Un proceso de Node con `ts-mls` y un proceso de Rust con OpenMLS se pasan KeyPackages, Welcomes, commits y mensajes en hexadecimal por la entrada y la salida estándar.

**Un detalle de `ts-mls` 1.6.4.** Importa `@noble/hashes` sin declararlo como dependencia. Por eso aparece en `package.json`.
