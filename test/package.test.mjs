// SPDX-License-Identifier: Apache-2.0
// What would leave this repository if the package were published, and what the MCP Registry would be told
// about its MCP server (server.json). Neither has been published: both have to be right the day they are.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = (file) => JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'));
const pkg = json('package.json');
const server = json('server.json');

test('the package carries the product and its licenses, and nothing else of this repository', () => {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const paths = packed.files.map((file) => file.path);
  const tops = [...new Set(paths.map((path) => path.split('/')[0]))].sort();
  assert.deepEqual(tops, ['LICENSE', 'LICENSES', 'README.md', 'bin', 'package.json', 'src']);
  // What is somebody else's to see only by the owner's decision: the hosted service, and how the project is run.
  for (const kept of ['docs/', 'test/', 'checks/', 'experiments/', 'deploy/', '.github/', 'CLAUDE.md', 'server.json']) {
    assert.equal(paths.some((path) => path === kept || path.startsWith(kept)), false, kept);
  }
  for (const needed of ['bin/agenthub.mjs', 'src/mcp/server.mjs', 'src/sdk/index.mjs', 'src/hub/server.mjs', 'LICENSES/Apache-2.0.txt', 'LICENSES/AGPL-3.0-only.txt']) assert.ok(paths.includes(needed), needed);
});

test('what the MCP Registry is told about the MCP server is what the package is', () => {
  const [entry] = server.packages;
  assert.equal(server.packages.length, 1);
  // The registry checks that whoever publishes owns the package by finding the server's name in it.
  assert.equal(pkg.mcpName, server.name);
  assert.match(server.name, /^[a-z0-9.-]+\/[a-z0-9._-]+$/);
  assert.deepEqual([entry.registryType, entry.identifier, entry.version, server.version], ['npm', pkg.name, pkg.version, pkg.version]);
  assert.ok(server.description.length <= 100, 'the registry takes a description of at most 100 characters');
  assert.deepEqual(entry.transport, { type: 'stdio' });

  // It is started the way the package starts it, and told what the server reads.
  const cli = readFileSync(resolve(ROOT, 'bin/agenthub.mjs'), 'utf8');
  assert.deepEqual(Object.keys(pkg.bin), ['agenthub']);
  assert.deepEqual(entry.packageArguments, [{ type: 'positional', value: 'mcp' }]);
  assert.match(cli, /case 'mcp': \{/);
  for (const variable of entry.environmentVariables) {
    assert.match(cli, new RegExp(`process\\.env\\.${variable.name}\\b`), variable.name);
    assert.equal(variable.isSecret, undefined, 'what goes in these is an address and a path, not a secret');
  }
  assert.deepEqual(entry.environmentVariables.map((variable) => variable.name), ['AGENTHUB_URL', 'AGENTHUB_IDENTITY']);
  // The defaults it tells are the ones the CLI has.
  for (const variable of entry.environmentVariables) assert.ok(cli.includes(`'${variable.default}'`), `${variable.name} defaults to ${variable.default}`);
});

test('the hub and the MCP server say the version of the package', async () => {
  const { VERSION } = await import('../src/hub/server.mjs');
  assert.equal(VERSION, pkg.version);
  assert.match(readFileSync(resolve(ROOT, 'src/mcp/server.mjs'), 'utf8'), new RegExp(`const SERVER_INFO = \\{ name: 'agent-hub', version: '${pkg.version.replace(/\./g, '\\.')}' \\};`));
});

test('the hosted service can take the package from GitHub as it is', () => {
  // It installs it from a tag and imports src/core, src/mls and src/sdk by their paths: an "exports" field
  // would close those paths, and a script that runs on install would run on every install of the service.
  assert.equal(pkg.exports, undefined);
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) assert.equal(pkg.scripts?.[script], undefined, script);
});
