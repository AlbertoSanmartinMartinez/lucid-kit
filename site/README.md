# La landing de LUCID

Una página estática, en inglés (`index.html`) y en español (`es/index.html`), sin dependencias ni paso de construcción. La sirve cualquier servidor de ficheros estáticos.

**Verla en local.** Los módulos de JavaScript no cargan desde `file://`, así que hace falta un servidor:

```bash
python3 -m http.server 8765 --bind 127.0.0.1 --directory site
# y abrir http://127.0.0.1:8765/ (inglés) o http://127.0.0.1:8765/es/ (español)
```

## Qué hay

| Fichero | Qué es |
|---|---|
| `index.html`, `es/index.html` | Las dos páginas. Tienen los mismos elementos con los mismos `id`; cambiar una es cambiar la otra |
| `assets/lucid.css` | La hoja de estilos de las dos |
| `assets/verify.mjs` | La comprobación de una firma de evento, escrita otra vez sin Node para que corra en el navegador: forma canónica (JCS), clave sacada del did:key y Ed25519 con WebCrypto |
| `assets/demo.mjs` | La demo de «Haz de hub»: el visitante cambia el evento haciendo de hub y la página vuelve a comprobar la firma. Los textos de cada estado están en la página (`data-*` de `#stamp` y `#verdict`), no en el script |
| `assets/motion.mjs` | El movimiento de las ilustraciones: cada una se mueve solo mientras está en pantalla, y la de cada letra empieza cuando se llega a ella. Con «reducir movimiento» en el sistema, todas quedan quietas en el fotograma que nombran (`data-still`) |
| `assets/fixtures.mjs` | El evento firmado y el estado del registro cofirmado que enseña la página. Lo escribe `tools/fixtures.mjs`: no se edita a mano |
| `tools/art.mjs` | Dibuja las ilustraciones isométricas en SVG con animación SMIL y las mete en las dos páginas, entre sus marcas `<!-- art:NOMBRE -->`: la escena de la cabecera (dos hubs con sus agentes, mensajes sellados que cruzan un puente, el registro que crece y su testigo) y una viñeta por letra. Cada parte va en la tinta de su letra (`TONES`, las mismas que `--log`, `--sign`, `--crypt`, `--bridge` y `--find` de la hoja de estilos). Los dibujos no llevan texto en ningún idioma: lo que muestran lo dice la página |
| `tools/fixtures.mjs` | Arranca en memoria un hub y un testigo con el código del repositorio, registra dos agentes y crea un topic, y escribe lo que la página enseña: el evento que firma uno de esos agentes y el estado del registro tal como lo sirve el hub (`/v1/log/note`), firmado por él y cofirmado por el testigo. Mete ese estado en las dos páginas, entre sus marcas `<!-- checkpoint -->` |
| `fonts/` | Atkinson Hyperlegible Next y Mono, del Braille Institute, solo el subconjunto latino, con su licencia (SIL OFL 1.1). Servidas desde el propio sitio: la página no pide nada a terceros |

```bash
node site/tools/art.mjs          # vuelve a dibujar las ilustraciones en las dos páginas
node site/tools/fixtures.mjs     # claves nuevas cada vez: nuevo evento y nuevo estado del registro
node --test test/site.test.mjs   # los tests de la página
```

## Lo que comprueban los tests (`test/site.test.mjs`)

- **La comprobación de la página dice lo mismo que la del núcleo** (`verifyEventEnvelope`), para el evento que enseña y para cada forma de cambiarlo: otro dato, otra hora, otro remitente, un campo de más o de menos, una firma de otra clave o hecha para otra cosa, una prueba rota. Reordenar las claves o escribir `42.0` en vez de `42` no rompe la firma en ninguna de las dos.
- **La forma canónica y la clave de un did:key** son las mismas que da el núcleo.
- **Lo que la página enseña es real:** el evento lo firma el agente que dice, y el estado del registro lo firma su hub y lo cofirma el testigo que nombra. Es el mismo en las dos páginas.
- **Las dos páginas son la misma:** los mismos `id`, ninguno repetido, los textos de cada estado de la demo en las dos, cada una enlaza a la otra, y existe todo lo que cargan.
- **Las ilustraciones son las que dibuja `tools/art.mjs`,** en las dos páginas, sin texto, ocultas a los lectores de pantalla, con su fotograma quieto, y en las mismas tintas que la hoja de estilos.

Corren con `npm test`, y en GitHub con Node 20, 22 y 24, que comprueban Ed25519 con WebCrypto como los navegadores.

Fuera de los tests, la página se ha probado en tres motores: Chrome, Firefox 153 y WebKit 26, el de Safari, este con el navegador que trae Playwright y no con Safari. En los tres se comprobó lo mismo. Carga sin errores ni peticiones fallidas y con sus fuentes. La demo da por buena la firma, por falsificado un número cambiado, por buena otra vez la misma en una línea y «no es un evento» al romper el JSON. Solo se mueve el dibujo que está en pantalla. En un teléfono, en español, nada se sale por los lados. Y con «reducir movimiento», cada dibujo queda quieto en su fotograma. Esto último fallaba en WebKit, que pone a cero el reloj de los dibujos justo después de cargar la página: `assets/motion.mjs` los vuelve a fijar entonces.

## Dónde está publicada

En **https://uselucid.org** (y `www.uselucid.org`), con DigitalOcean App Platform como sitio estático: sirve esta carpeta tal cual, sin paso de construcción, y la vuelve a publicar en cada push a `main`. Lo que DigitalOcean sabe de ella está en `.do/app.yaml`, en la raíz del repositorio, que no lleva ningún secreto. Se creó una vez con `doctl apps create --spec .do/app.yaml`, y un cambio en ese fichero se aplica con `doctl apps update ID --spec .do/app.yaml`. La app se llama `lucid-landing` y su dirección de DigitalOcean es `lucid-landing-jix5c.ondigitalocean.app`. El DNS del dominio está en Cloudflare: dos CNAME (`@` y `www`) a esa dirección, sin su proxy, para que DigitalOcean saque el certificado (Let's Encrypt, para `uselucid.org` y `*.uselucid.org`, que renueva solo).

Cada página dice su dirección canónica y la de la otra lengua (`hreflang`), y los enlaces de contacto van a `info@albertosanmartinmartinez.es`. La CDN de DigitalOcean, que es Cloudflare, esconde ese correo en el HTML que sirve y añade un script suyo, servido desde el mismo dominio, que lo descifra al cargar la página: sin JavaScript, el enlace lleva a una página de Cloudflare.

Falta una imagen para compartir el enlace (`og:image`).

## Lo que no hace

- **Sin analítica y sin cookies.** No sabe quién la visita. De terceros solo lleva el script con que la CDN descifra el correo, que pone ella (arriba).
- **Sin modo oscuro.**
- **Las ilustraciones se mueven con SMIL,** que todos los navegadores actuales entienden. Sin JavaScript se mueven igualmente, aunque se haya pedido menos movimiento.
- **Un navegador sin Ed25519 en WebCrypto** (versiones antiguas) ve la demo pero no la comprueba, y la página lo dice.
