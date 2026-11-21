# SPDX-License-Identifier: Apache-2.0
# Mutations of: witnesses of the transparency log: what a witness cosigns, the formats, and what a client asks of them (section 32).
# Run from anywhere: python3 experiments/mutations/witness.py [text of one description]
from harness import run

W, N, F, H = 'src/core/witness.mjs', 'src/core/note.mjs', 'src/sdk/follower.mjs', 'src/hub/server.mjs'
mutations = [
    (W, "if (request.old !== known.size) return {", "if (false) return {", 'witness: asked from anywhere'),
    (W, "verifyConsistency({ first: known.size, second: size, firstRoot: known.root, secondRoot: root, proof: request.proof })", "true", 'witness: no proof checked'),
    (W, "if (!checkSignatures(request.text, request.signatures, { log }).byLog) return plain(403, 'the checkpoint is not signed by its log');", "checkSignatures(request.text, request.signatures, { log });", 'witness: a checkpoint nobody it knows signed'),
    (W, "if (request.old > size) return plain(400, 'the old size is greater than the size of the checkpoint');\n", "", 'witness: old greater than size'),
    (W, "if (size === 0 && !root.equals(EMPTY_ROOT)) return plain(422, 'an empty log with a root that is not that of an empty one');\n", "", 'witness: an empty log with a root'),
    (W, "const follows = known.size === 0 ? request.proof.length === 0 :", "const follows = known.size === 0 ? true :", 'witness: a proof from nothing'),
    (W, "if (!log) return plain(404, 'a log this witness does not watch');\n", "if (!log) return plain(403, 'x');\n", 'witness: unknown log is 404'),
    (N, "const cosignatureInput = (text, time) => Buffer.from(`${COSIGNATURE_PREFIX}time ${time}\\n${text}`, 'utf8');", "const cosignatureInput = (text, time) => Buffer.from(`time ${time}\\n${text}`, 'utf8');", 'note: what a witness signs has no first line'),
    (N, "if (line.signature.length !== 64 || !edVerify(null, Buffer.from(text, 'utf8'), publicKeyFromBytes(log.key), line.signature)) throw new TypeError('the signature of the log on the note does not verify');", "", 'note: the signature of the log is not checked'),
    (N, "!edVerify(null, cosignatureInput(text, time), publicKeyFromBytes(witness.key), line.signature.subarray(8))", "false", 'note: a cosignature is not checked'),
    (N, "times.set(witness.name, Math.max(time, times.get(witness.name) ?? 0));", "times.set(witness.name + times.size, time);", 'note: one witness counted more than once'),
    (N, "if (noteKeyId(name, type, key).toString('hex') !== id) throw new TypeError('the id of a verifier key is not the one its name and key give');\n", "", 'note: a verifier key with any id'),
    (F, "if (lately.length < this.#quorum) {", "if (false) {", 'follower: no quorum asked'),
    (F, "const lately = seen.cosigned.filter(({ time }) => time <= now + CLOCK_SKEW_S && now - time <= this.#witnessMaxAgeMs / 1000);", "const lately = seen.cosigned.filter(({ time }) => time <= now + CLOCK_SKEW_S);", 'follower: a cosignature of any age'),
    (F, "const lately = seen.cosigned.filter(({ time }) => time <= now + CLOCK_SKEW_S && now - time <= this.#witnessMaxAgeMs / 1000);", "const lately = seen.cosigned.filter(({ time }) => now - time <= this.#witnessMaxAgeMs / 1000);", 'follower: a cosignature from the future'),
    (F, "if (checkpoint.origin !== hub || !seen.byLog) throw new LogError('the cosigned checkpoint the hub shows is not one of its own log');\n", "", 'follower: a checkpoint the hub did not sign'),
    (F, "if (!begins) throw new LogError('what the witnesses cosigned is not the log the hub shows this client');\n", "", 'follower: what was cosigned need not be where the log begins'),
    (F, "if (checkpoint.size < this.#witnessedSize) throw new LogError(`the hub showed ${this.#witnessedSize} entries of its log cosigned and now shows ${checkpoint.size}`);\n", "", 'follower: shown less cosigned than before'),
    (F, "if (this.#witnesses.length > 0 && !(await this.#heldToWitnesses())) {", "if (false) {", 'follower: witnesses never asked'),
    (F, "      if (this.#witnesses.length > 0) throw new LogError('the hub keeps no log for the witnesses this client asks for to have cosigned', 'log_unwitnessed');\n", "", 'follower: a hub with no log, taken'),
    (F, "this.#quorum = quorum ?? Math.floor(this.#witnesses.length / 2) + 1;", "this.#quorum = quorum ?? 1;", 'follower: one of two is enough by default'),
    (H, "if (old > size) throw new Error(`it has cosigned ${old} entries of this log, more than the log has now: a log that went back is not cosigned`);\n", "", 'hub: asks for a log that went back'),
    (H, "if (checkSignatures(text, lines, { witnesses: [witness.verifier] }).cosigned.length !== 1) throw new Error('its answer carries no cosignature of its key');\n", "", 'hub: keeps an answer that is not a cosignature of that witness'),
    (H, "if (witnesses.length > 0 && witnessed === null) throw new HttpError(404, 'not_witnessed', 'no witness has cosigned the log of this hub yet');\n", "", 'hub: shows its own word where witnesses were asked'),
]

run(mutations, ['test/witness.test.mjs'])
