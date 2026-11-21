// Demo de extremo a extremo: dos agentes se descubren y colaboran a través del hub.
//
//   node examples/demo.mjs                 -> arranca un hub en memoria y ejecuta el flujo
//   AGENTHUB_URL=http://127.0.0.1:8787 node examples/demo.mjs   -> usa un hub que ya está en marcha

import { createHub } from '../src/hub/server.mjs';
import { AgentClient, attachCertificate, createDelegation, createRevocation, generateIdentity, generateInstanceIdentity, submitRevocation } from '../src/sdk/index.mjs';
import { CONTEXT, createProof } from '../src/core/sign.mjs';
import { signRequest } from '../src/core/reqsig.mjs';

const TOPIC = 'dev.rust.code-review.requests';
let stepNumber = 0;
const step = (title) => console.log(`\n${++stepNumber}. ${title}`);
const note = (text) => console.log(`   ${text}`);
const short = (did) => `${did.slice(0, 20)}…${did.slice(-6)}`;

/** Resuelve cuando al agente le llega el siguiente mensaje verificado. */
function nextMessage(queue) {
  return new Promise((resolve) => {
    if (queue.items.length > 0) resolve(queue.items.shift());
    else queue.waiting = resolve;
  });
}
function inboxOf(client) {
  const queue = { items: [], waiting: null };
  const listener = client.listen((message) => {
    if (queue.waiting) {
      const resolve = queue.waiting;
      queue.waiting = null;
      resolve(message);
    } else {
      queue.items.push(message);
    }
  });
  return { queue, listener };
}

// La clave de quien controla al builder. El operador del hub de la demo la da por verificada.
const controllerIdentity = generateIdentity();
const ownHub = process.env.AGENTHUB_URL
  ? null
  : await createHub({ port: 0, quiet: true, verifiedControllers: { [controllerIdentity.did]: 'github:demo' } }).listen();
const hubUrl = process.env.AGENTHUB_URL ?? ownHub.url;
console.log(`Hub: ${hubUrl}${ownHub ? ' (en memoria, arrancado por la demo)' : ''}`);

// `mls: true` guarda el estado de MLS en memoria: basta para una demo. Un agente real usa un
// directorio de estado (fileStateStore), que es lo que hace el CLI por su cuenta.
const reviewer = new AgentClient({ hubUrl, mls: true });
const builder = new AgentClient({ hubUrl, mls: true });
const attackerIdentity = generateIdentity();
const attacker = new AgentClient({ hubUrl, identity: attackerIdentity });
let otherHub = null; // el hub de otra empresa, para el último paso
let visitor = null;

try {
  step('Cada agente genera su clave en local y se registra (con prueba de trabajo)');
  let started = Date.now();
  await reviewer.register({
    name: 'rust-reviewer',
    description: 'Revisa pull requests de Rust: unsafe, rendimiento y estilo',
    skills: [{ name: 'code review', description: 'Revisión de código Rust' }],
  });
  note(`rust-reviewer  ${short(reviewer.did)}  (registro en ${Date.now() - started} ms)`);
  started = Date.now();
  await builder.register({ name: 'acme-builder', description: 'Agente de CI de Acme' });
  note(`acme-builder   ${short(builder.did)}  (registro en ${Date.now() - started} ms)`);
  await attacker.register({ name: 'mallory' });
  note(`mallory        ${short(attacker.did)}  (lo usaremos para atacar)`);

  step('El revisor declara un topic público con su contrato (JSON Schema)');
  try {
    await reviewer.createTopic({
      name: TOPIC,
      description: 'Peticiones de revisión de código Rust (code review requests)',
      schema: {
        type: 'object',
        required: ['repo', 'pr'],
        additionalProperties: false,
        properties: {
          repo: { type: 'string', maxLength: 200 },
          pr: { type: 'integer', minimum: 1 },
          focus: { type: 'array', maxItems: 5, items: { type: 'string', enum: ['unsafe', 'performance', 'style'] } },
        },
      },
    });
    note(`${TOPIC} creado`);
  } catch (err) {
    if (err.code !== 'topic_exists') throw err;
    note(`${TOPIC} ya existía en este hub: lo reutilizamos`);
  }
  await reviewer.subscribe(TOPIC);
  const reviewerInbox = inboxOf(reviewer);
  await reviewerInbox.listener.ready;
  note('rust-reviewer se suscribe y abre su stream (conexión saliente, sin IP pública)');

  step('El builder no conoce el topic: lo descubre describiendo lo que necesita');
  const query = 'revisión de código en Rust';
  const [match] = await builder.searchTopics(query);
  note(`búsqueda: "${query}"  ->  ${match.name}  (score ${match.score})`);
  const owner = await builder.getAgent(match.owner);
  note(`dueño del topic: ${owner.card.name}, tarjeta verificada en local, nivel "${owner.tier}"`);

  step('El builder publica una petición firmada');
  const receipt = await builder.publish(TOPIC, {
    type: 'dev.rust.code-review.request',
    data: { repo: 'https://github.com/acme/parser', pr: 42, focus: ['unsafe', 'performance'] },
  });
  note(`aceptada por el hub: seq ${receipt.seq}, entregada a ${receipt.delivered_to} suscriptor(es)`);

  step('El revisor la recibe; su SDK ha verificado firma, topic y esquema por su cuenta');
  const request = await nextMessage(reviewerInbox.queue);
  note(`de ${short(request.sender)}  tipo ${request.type}`);
  note('así se le pasaría el contenido a un modelo, marcado como dato no fiable:');
  console.log(request.toModelContext().split('\n').map((line) => `      ${line}`).join('\n'));

  step('El hub rechaza lo que no cumple el contrato del topic');
  const invalid = await builder.publish(TOPIC, { type: 'dev.rust.code-review.request', data: { repo: 'x', pr: 'cuarenta y dos' } }).catch((err) => err);
  note(`payload inválido -> ${invalid.status} ${invalid.code}: ${invalid.details.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);

  step('Un atacante intenta publicar haciéndose pasar por el builder');
  const forgedEvent = {
    specversion: '1.0',
    id: 'forged-1',
    source: builder.did, // dice ser el builder...
    type: 'dev.rust.code-review.request',
    time: new Date().toISOString(),
    subject: TOPIC,
    data: { repo: 'https://evil.example/backdoor', pr: 1 },
  };
  const forged = Buffer.from(JSON.stringify({ event: forgedEvent, proof: createProof(CONTEXT.EVENT, forgedEvent, attackerIdentity) })); // ...pero firma mallory
  const path = `/v1/topics/${TOPIC}/events`;
  const res = await fetch(hubUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signRequest(attackerIdentity, 'POST', hubUrl + path, forged) },
    body: forged,
  });
  const rejection = (await res.json()).error;
  note(`suplantación -> ${res.status} ${rejection.code}: ${rejection.message}`);

  step('El revisor contesta al builder por mensaje directo, usando su identificador');
  const builderInbox = inboxOf(builder);
  await builderInbox.listener.ready;
  await reviewer.send(builder.did, {
    type: 'dev.rust.code-review.question',
    data: { about: request.id, text: '¿Reviso también los tests de integración?' },
  });
  const question = await nextMessage(builderInbox.queue);
  note(`acme-builder recibe de ${short(question.sender)}: "${question.data.text}"`);
  note(`cifrado de extremo a extremo: ${question.encrypted ? 'sí' : 'no'} (${question.encryption}); el hub solo vio un evento de tipo "${question.event.type}"`);
  note('con MLS, la clave que abrió ese mensaje ya no existe: quien robe mañana el estado del builder no podrá leerlo');

  step('El builder se desconecta; lo que le envían espera en su buzón');
  await builderInbox.listener.close();
  const queued = await reviewer.send(builder.did, {
    type: 'dev.rust.code-review.result',
    data: { about: request.id, verdict: 'changes-requested', comments: 3 },
  });
  note(`enviado con el destinatario ${queued.recipient_online ? 'conectado' : 'desconectado'}`);
  const { messages } = await builder.poll();
  note(`al volver, acme-builder recoge ${messages.length} mensaje: veredicto "${messages[0].data.verdict}", ${messages[0].data.comments} comentarios`);
  const renewed = await builder.renewConversationKeys(reviewer.did);
  note(`acme-builder renueva sus claves en la conversación (época ${renewed.epoch}): una copia de su estado anterior ya no leería lo que llegue después`);

  step('El revisor abre un topic privado con el builder: el hub reparte lo que no puede leer');
  const PRIVATE = 'dev.rust.review-42.private';
  await reviewer.createTopic({
    name: PRIVATE,
    description: 'Canal privado de la revisión del PR 42',
    schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    private: true,
    members: [builder.did],
  });
  await builder.subscribe(PRIVATE);
  await reviewer.publish(PRIVATE, { type: 'dev.rust.review.finding', data: { text: 'La función parse_header lee fuera del búfer' } });
  if (ownHub) {
    const waiting = ownHub.store.pending(builder.did).at(-1).envelope.event;
    note(`lo que el hub tiene para el builder: tipo "${waiting.type}", ${waiting.data.message.length} caracteres cifrados sobre MLS. No guarda historial: no podría abrirlo nadie`);
  }
  const finding = (await builder.poll()).messages[0];
  note(`lo que lee el builder, que está en el grupo del topic: "${finding.data.text}" (${finding.encryption})`);
  const without = await reviewer.removeTopicMembers(PRIVATE, [builder.did]);
  const shutOut = await builder.publish(PRIVATE, { type: 'x', data: { text: 'sigo aquí' } }).catch((err) => err);
  note(`el revisor lo saca del topic: el grupo pasa a la época ${without.epoch}, con claves que el builder no tiene; si intenta publicar -> ${shutOut.status} ${shutOut.code}`);

  step('El revisor arranca una segunda instancia en un servidor, con una clave propia');
  const serverIdentity = generateInstanceIdentity(); // se genera en el servidor y no sale de él
  const certificate = reviewer.certifyInstance(serverIdentity.instance.did, { name: 'servidor', days: 30 }); // lo firma el agente, donde esté su clave
  const server = new AgentClient({ hubUrl, identity: attachCertificate(serverIdentity, certificate), mls: true });
  await server.registerInstance();
  note(`instancia ${short(server.instanceDid)} registrada con un certificado del agente (30 días); la clave del agente no ha viajado`);
  await server.send(builder.did, { type: 'dev.rust.code-review.note', data: { text: 'Sigo con la revisión desde el servidor' } });
  const fromServer = (await builder.poll()).messages[0];
  note(`el builder recibe "${fromServer.data.text}" de ${short(fromServer.sender)}: el remitente verificado es el agente`);
  note(`firmó la instancia ${short(fromServer.instance)}, y el SDK del builder comprobó su certificado sin fiarse del hub`);
  await builder.send(reviewer.did, { type: 'dev.rust.code-review.thanks', data: { text: 'Gracias, sigo atento' } });
  await nextMessage(reviewerInbox.queue);
  const sealed = (await server.poll()).messages[0];
  note(`el builder contesta cifrado (${sealed.encryption}) y la instancia lo lee: "${sealed.data.text}". Al entrar ella, la conversación pasó a un grupo nuevo`);
  await builder.publish(TOPIC, { type: 'dev.rust.code-review.request', data: { repo: 'https://github.com/acme/parser', pr: 43 } });
  const atAgent = await nextMessage(reviewerInbox.queue);
  const atServer = (await server.poll()).messages[0];
  note(`una petición nueva (PR ${atAgent.data.pr}) llega a la clave del agente y también a la instancia (PR ${atServer.data.pr}): cada una lee de su buzón`);
  await reviewer.removeInstance(server.instanceDid);
  const removed = await server.poll().catch((err) => err);
  note(`el revisor retira la instancia; su siguiente petición -> ${removed.status} ${removed.code}. El agente sigue igual`);

  step('Quien controla al builder firma una delegación con alcance limitado');
  const delegation = createDelegation(controllerIdentity, {
    subject: builder.did,
    days: 30,
    scope: { publish: ['dev.rust.*'], subscribe: ['dev.rust.*'], topics_create: false },
  });
  const delegated = await builder.attachDelegation(delegation);
  note(`acme-builder pasa a nivel "${delegated.tier}" (controlador verificado como: ${delegated.controller.verified_as ?? 'nadie'})`);
  const outside = await builder.createTopic({ name: 'ops.fuera.de.alcance', description: 'Un topic que la delegación no permite crear', schema: { type: 'object' } }).catch((err) => err);
  note(`crear un topic, que la delegación no permite -> ${outside.status} ${outside.code}`);

  step('El portátil del builder se pierde: su controlador lo revoca sin tocar el agente');
  const revoked = await submitRevocation(hubUrl, createRevocation(controllerIdentity, { delegation: delegation.delegation, reason: 'portátil perdido' }));
  note(`revocación aceptada: agente revocado = ${revoked.agent_revoked}`);
  const locked = await builder.send(reviewer.did, { type: 'x', data: {} }).catch((err) => err);
  note(`siguiente petición del builder -> ${locked.status} ${locked.code}`);
  const after = await reviewer.getAgent(builder.did);
  note(`así lo ve ahora el revisor: estado "${after.status}", motivo "${after.revoked.reason}"`);

  step('El hub lleva un registro público de cada cambio de su directorio, y cualquiera puede repasarlo entero');
  const { hub: hubIdentity } = await reviewer.info();
  const audit = await reviewer.auditLog({ hub: hubIdentity.did });
  note(`el revisor lo lee desde la primera entrada: ${audit.size} entradas, firmadas por el hub ${short(audit.hub)}, y se sostiene`);
  note(`según el registro, acme-builder está "${audit.directory.agents.get(builder.did).status}" y el dueño de ${TOPIC} es ${audit.directory.topics.get(TOPIC).owner === reviewer.did ? 'el revisor' : 'otro'}`);
  note(`desde la entrada ${audit.directory.signedFrom}, lo que cambia un agente va apuntado con su firma: el hub no puede crear un topic a nombre de otro, cambiar quién lo usa ni retirar a nadie por su cuenta`);
  note('un agente que guarda estado (el CLI, el servidor MCP) lo sigue por su cuenta, y contrasta con él lo que el hub le enseña');

  if (ownHub) {
    step('Otra empresa tiene su propio hub: los dos operadores los emparejan y un agente de allí usa el topic de aquí y escribe al revisor');
    otherHub = await createHub({ port: 0, quiet: true }).listen();
    ownHub.addPeer({ name: 'globex', url: otherHub.url, did: otherHub.did });
    otherHub.addPeer({ name: 'acme', url: ownHub.url, did: ownHub.did });
    note(`cada operador le da a su hub la dirección y la clave del otro: ${short(ownHub.did)} y ${short(otherHub.did)}`);
    visitor = new AgentClient({ hubUrl: otherHub.url, mls: true });
    await visitor.register({ name: 'globex-builder', description: 'Agente de CI de Globex' });
    const [remote] = await visitor.searchTopics(query);
    note(`globex-builder busca en su hub "${query}"  ->  ${remote.name}  (vive en el hub que el suyo llama "${remote.peer}")`);
    await visitor.subscribe(remote.name);
    const crossed = await visitor.publish(remote.name, { type: 'dev.rust.code-review.request', data: { repo: 'https://github.com/globex/engine', pr: 7 } });
    let arrived;
    do arrived = await nextMessage(reviewerInbox.queue);
    while (arrived.sender !== visitor.did);
    note(`publica una petición: la acepta el hub del topic (seq ${crossed.seq}) y le llega al revisor, firmada por ${short(arrived.sender)} y venida por "${arrived.hub.via}"`);
    await reviewer.publish(TOPIC, { type: 'dev.rust.code-review.request', data: { repo: 'https://github.com/acme/parser', pr: 43 } });
    let reply = [];
    for (let waited = 0; reply.length === 0 && waited < 5000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      reply = (await visitor.poll()).messages;
    }
    note(`lo que el revisor publica en el topic le llega a través de su hub: PR ${reply[0].data.pr}, en "${reply[0].topic}"`);
    const [colleague] = (await visitor.searchAgents('revisa pull requests de Rust')).filter((agent) => agent.did === reviewer.did);
    const written = await visitor.send(colleague.address, { type: 'question', data: { text: '¿Podéis revisar también el PR 8?' } });
    let question;
    do question = await nextMessage(reviewerInbox.queue);
    while (question.kind !== 'direct' || question.sender !== visitor.did);
    note(`le escribe al revisor, que su hub le da como ${short(reviewer.did)}@${colleague.peer}: sobre MLS (${written.encryption}), como dentro de un hub, y ninguno de los dos hubs lo lee`);
    await reviewer.send(question.replyTo, { type: 'answer', data: { text: 'Hecho, tiene dos comentarios' } });
    let answer = [];
    for (let waited = 0; answer.length === 0 && waited < 5000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      answer = (await visitor.poll()).messages;
    }
    note(`el revisor contesta a la dirección con la que le llegó (…@${question.replyTo.split('@')[1]}): "${answer[0].data.text}" (${answer[0].encryption})`);
    note('la conversación tiene una casa, uno de los dos hubs, que ordena sus cambios; el otro le pregunta. Un agente sin MLS seguiría recibiendo sellado con HPKE');
    note('ningún hub se fía del otro: el del topic comprobó la firma y el contrato, y el SDK de cada agente, otra vez');
  } else {
    note('(el paso de los dos hubs emparejados solo se muestra con el hub en memoria de la demo: emparejar es cosa de quien opera el hub)');
  }

  console.log('\nFlujo completo. Todo lo recibido se verificó en el extremo, sin confiar en el hub.');
} finally {
  await Promise.all([reviewer.close(), builder.close(), attacker.close(), visitor?.close()]);
  if (otherHub) await otherHub.close();
  if (ownHub) await ownHub.close();
}
