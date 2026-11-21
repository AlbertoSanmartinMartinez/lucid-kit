// SPDX-License-Identifier: Apache-2.0
// Where a client keeps what it must remember between runs to use MLS: the secrets of the
// KeyPackages it has published and the state of the groups it is in.
//
// With forward secrecy, forgetting is part of the protocol: a key is deleted once used, so the
// state after reading a message cannot read it again. That only works if the state is saved as it
// advances. A client with nowhere to save it would lose its conversations at every restart, which
// is why MLS is on only when a store is given (or asked for explicitly, in memory).
//
// A store maps string keys to bytes. What it holds is as sensitive as the identity file.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Keeps everything in memory: enough for one process, gone when it ends. */
export function memoryStateStore() {
  const entries = new Map();
  return {
    get: (key) => entries.get(key) ?? null,
    set: (key, bytes) => void entries.set(key, Buffer.from(bytes)),
    delete: (key) => void entries.delete(key),
    keys: (prefix = '') => [...entries.keys()].filter((key) => key.startsWith(prefix)),
  };
}

/** Keeps each entry in a file of its own under `dir`, readable by the owner only. */
export function fileStateStore(dir) {
  const fileOf = (key) => join(dir, Buffer.from(key, 'utf8').toString('base64url'));
  const ensureDir = () => {
    if (existsSync(dir)) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  };
  return {
    get(key) {
      const file = fileOf(key);
      return existsSync(file) ? readFileSync(file) : null;
    },
    set(key, bytes) {
      ensureDir();
      const file = fileOf(key);
      // Written whole and then renamed: a crash leaves the old state or the new one, never half of one.
      writeFileSync(`${file}.tmp`, bytes, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    },
    delete(key) {
      const file = fileOf(key);
      if (existsSync(file)) unlinkSync(file);
    },
    keys(prefix = '') {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((name) => !name.endsWith('.tmp'))
        .map((name) => Buffer.from(name, 'base64url').toString('utf8'))
        .filter((key) => key.startsWith(prefix));
    },
  };
}
