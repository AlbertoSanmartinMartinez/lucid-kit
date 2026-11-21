// SPDX-License-Identifier: Apache-2.0
// A small, strict subset of JSON Schema.
//
// Topics declare the shape of their payloads with a schema. This validator
// supports a deliberately small set of keywords, and `checkSchema` REJECTS
// schemas that use anything else: silently ignoring a keyword would make the
// hub claim a validation it is not doing. `pattern` is excluded on purpose
// (running publisher-supplied regexes against untrusted strings invites ReDoS).

import { jsonEqual } from './jcs.mjs';

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'default', 'examples', 'format']);
const NUMERIC = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'];
const COUNTS = ['minLength', 'maxLength', 'minItems', 'maxItems'];
const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', ...NUMERIC, ...COUNTS]);

const MAX_SCHEMA_DEPTH = 16;
const MAX_DATA_DEPTH = 64;
const MAX_ERRORS = 10;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Returns a list of problems with the schema itself; empty means the schema is usable. */
export function checkSchema(schema, path = '#', depth = 0, problems = []) {
  if (!isPlainObject(schema)) {
    problems.push(`${path}: schema must be an object`);
    return problems;
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    problems.push(`${path}: schema is nested too deeply`);
    return problems;
  }
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    if (!KEYWORDS.has(key)) {
      problems.push(`${path}: unsupported keyword "${key}"`);
      continue;
    }
    switch (key) {
      case 'type': {
        const types = Array.isArray(value) ? value : [value];
        if (types.length === 0 || !types.every((t) => TYPES.has(t))) problems.push(`${path}/type: unknown type`);
        break;
      }
      case 'properties':
        if (!isPlainObject(value)) {
          problems.push(`${path}/properties: must be an object`);
        } else if (Object.keys(value).length > 100) {
          problems.push(`${path}/properties: too many properties`);
        } else {
          for (const [name, sub] of Object.entries(value)) checkSchema(sub, `${path}/properties/${name}`, depth + 1, problems);
        }
        break;
      case 'required':
        if (!Array.isArray(value) || !value.every((name) => typeof name === 'string')) {
          problems.push(`${path}/required: must be an array of strings`);
        }
        break;
      case 'additionalProperties':
        if (typeof value !== 'boolean') checkSchema(value, `${path}/additionalProperties`, depth + 1, problems);
        break;
      case 'items':
        checkSchema(value, `${path}/items`, depth + 1, problems);
        break;
      case 'enum':
        if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
          problems.push(`${path}/enum: must be a non-empty array (max 100 values)`);
        }
        break;
      case 'const':
        break;
      default:
        if (NUMERIC.includes(key) && !(typeof value === 'number' && Number.isFinite(value))) {
          problems.push(`${path}/${key}: must be a number`);
        }
        if (COUNTS.includes(key) && !(Number.isInteger(value) && value >= 0)) {
          problems.push(`${path}/${key}: must be a non-negative integer`);
        }
    }
  }
  return problems;
}

function matchesType(type, value) {
  switch (type) {
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    default:
      return typeof value === type; // string, number, boolean
  }
}

/** Validates data against a schema accepted by checkSchema. Returns [{ path, message }]. */
export function validate(schema, data, path = '', errors = [], depth = 0) {
  if (errors.length >= MAX_ERRORS) return errors;
  const fail = (message) => errors.push({ path: path || '/', message });
  if (depth > MAX_DATA_DEPTH) {
    fail('value is nested too deeply');
    return errors;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(type, data))) {
      fail(`expected ${types.join(' or ')}`);
      return errors;
    }
  }
  if (schema.const !== undefined && !jsonEqual(schema.const, data)) fail('must equal the constant value');
  if (schema.enum !== undefined && !schema.enum.some((option) => jsonEqual(option, data))) fail('must be one of the allowed values');

  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) fail(`must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && data > schema.maximum) fail(`must be <= ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && data <= schema.exclusiveMinimum) fail(`must be > ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && data >= schema.exclusiveMaximum) fail(`must be < ${schema.exclusiveMaximum}`);
  } else if (typeof data === 'string') {
    const length = [...data].length; // code points, as JSON Schema specifies
    if (schema.minLength !== undefined && length < schema.minLength) fail(`must have at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && length > schema.maxLength) fail(`must have at most ${schema.maxLength} characters`);
  } else if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) fail(`must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && data.length > schema.maxItems) fail(`must have at most ${schema.maxItems} items`);
    if (schema.items !== undefined) {
      for (let i = 0; i < data.length && errors.length < MAX_ERRORS; i++) {
        validate(schema.items, data[i], `${path}/${i}`, errors, depth + 1);
      }
    }
  } else if (isPlainObject(data)) {
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(data, name)) errors.push({ path: `${path}/${name}`, message: 'is required' });
    }
    for (const key of Object.keys(data)) {
      if (errors.length >= MAX_ERRORS) break;
      if (Object.hasOwn(properties, key)) {
        validate(properties[key], data[key], `${path}/${key}`, errors, depth + 1);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: `${path}/${key}`, message: 'is not allowed' });
      } else if (isPlainObject(schema.additionalProperties)) {
        validate(schema.additionalProperties, data[key], `${path}/${key}`, errors, depth + 1);
      }
    }
  }
  return errors;
}
