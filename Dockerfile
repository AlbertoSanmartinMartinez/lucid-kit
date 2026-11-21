# Agent Hub: un único proceso de Node. La misma imagen sirve el hub (por defecto) y el verificador de
# cuentas, cambiando la orden: node bin/agenthub.mjs verifier ...
# BASE deja fijar otra imagen de Node: un espejo propio, o una con la autoridad de certificación de un
# proxy corporativo.
ARG BASE=node:22-alpine
FROM ${BASE}
WORKDIR /app
# Las dependencias (la librería de MLS) se instalan desde el fichero de bloqueo, con las versiones exactas.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY LICENSE ./
COPY LICENSES ./LICENSES
COPY bin ./bin
COPY src ./src
RUN mkdir /data && chown node:node /data
USER node
ENV PORT=8787
EXPOSE 8787
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Escucha en todas las interfaces porque dentro del contenedor no hay otra forma de alcanzarlo.
# Delante debe ir un proxy que termine TLS (TRUST_PROXY=1), o bien monta un certificado y usa --tls-cert/--tls-key.
ENTRYPOINT ["node", "bin/agenthub.mjs", "hub", "--host", "0.0.0.0", "--data-dir", "/data"]
