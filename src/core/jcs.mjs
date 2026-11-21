// SPDX-License-Identifier: Apache-2.0
// JSON Canonicalization Scheme (RFC 8785).
//
// ECMAScript's JSON.stringify already produces the number and string
// serialization that JCS mandates, so canonicalization reduces to sorting
// object keys by UTF-16 code units (the default JS string order) and
// emitting no insignificant whitespace.

const MAX_DEPTH = 64;

export function canonicalize(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new TypeError('JCS: value is nested too deeply');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('JCS: non-finite numbers are not valid JSON');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((item) => canonicalize(item, depth + 1)).join(',') + ']';
      }
      const parts = [];
      for (const key of Object.keys(value).sort()) {
        parts.push(JSON.stringify(key) + ':' + canonicalize(value[key], depth + 1));
      }
      return '{' + parts.join(',') + '}';
    }
    default:
      throw new TypeError(`JCS: unsupported value of type ${typeof value}`);
  }
}

/**
 * Whether `value` is nested no deeper than canonicalize() takes. What is deeper cannot be signed
 * or hashed, so it cannot be put anywhere that asks for either.
 */
export function fitsCanonicalDepth(value, depth = 0) {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value !== 'object') return true;
  return (Array.isArray(value) ? value : Object.values(value)).every((item) => fitsCanonicalDepth(item, depth + 1));
}

/** Deep equality of two JSON values. */
export function jsonEqual(a, b) {
  return canonicalize(a) === canonicalize(b);
}
