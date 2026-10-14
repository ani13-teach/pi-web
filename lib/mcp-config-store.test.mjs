import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getMcpConfigRevision, mutateMcpConfig, readMcpConfigView, redactMcpConfig } from './mcp-config-store.ts';
import { MCP_REDACTED as hidden } from './mcp-types.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-mcp-store-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = { agentDir: join(root, 'agent'), cwd: join(root, 'project'), projectTrusted: true };
  mkdirSync(context.agentDir); mkdirSync(join(context.cwd, '.pi'), { recursive: true });
  const paths = { global: join(context.agentDir, 'mcp.json'), project: join(context.cwd, '.pi', 'mcp.json') };
  return { context, paths, put: (scope, doc) => writeFileSync(paths[scope], JSON.stringify(doc)), disk: (scope) => JSON.parse(readFileSync(paths[scope], 'utf8')) };
}
const save = (context, scope, name, config, revision = getMcpConfigRevision(context)) => mutateMcpConfig(context, { scope, name, config, revision, operation: 'upsert' });
const rejects = (promise, status, code) => assert.rejects(promise, error => error.status === status && (!code || error.code === code));

test('installed core validator returns normalized object or an error string', async () => {
  const require = createRequire(import.meta.url);
  let entry;
  try { entry = require.resolve('@earendil-works/pi-coding-agent'); }
  catch { entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')); }
  const { validateMcpServerConfig } = await import(pathToFileURL(join(dirname(entry), 'core/mcp-servers.js')).href);
  assert.deepEqual(validateMcpServerConfig('ok', { command: 'node', exposure: 'codemode-deferred', vendor: 1 }), { command: 'node', exposure: 'codemode', vendor: 1 });
  assert.equal(typeof validateMcpServerConfig('bad', { type: 'sse', url: 'https://example.invalid' }), 'string');
});

test('two scopes use fixed paths and retain unrelated and unknown fields', async t => {
  const f = fixture(t);
  f.put('global', { autoEnableCodemode: false, vendor: { preserve: 7 }, mcpServers: { original: { command: 'node', custom: { a: 1, b: 2 } }, unrelated: { command: 'python', env: { PASSWORD: 'untouched' } } } });
  f.put('project', { projectExtra: true, mcpServers: { original: { enabled: false, exposure: 'hidden', vendor: 'keep-existing' } } });
  const projectBytes = readFileSync(f.paths.project, 'utf8');
  const globalView = await save(f.context, 'global', 'original', { custom: { a: 3 }, enabled: true });
  assert.equal(globalView.path, f.paths.global);
  assert.equal(globalView.servers.find(s => s.name === 'original').config.command, 'node');
  assert.deepEqual(f.disk('global').mcpServers.original.custom, { a: 3, b: 2 });
  assert.equal(f.disk('global').autoEnableCodemode, false);
  assert.equal(f.disk('global').vendor.preserve, 7);
  assert.equal(f.disk('global').mcpServers.unrelated.env.PASSWORD, 'untouched');
  assert.equal(readFileSync(f.paths.project, 'utf8'), projectBytes);
  const globalBytes = readFileSync(f.paths.global, 'utf8');
  const view = await save(f.context, 'project', 'original', { enabled: true });
  assert.equal(view.servers[0].overrideOnly, true);
  assert.equal(f.disk('project').mcpServers.original.vendor, 'keep-existing');
  assert.equal(f.disk('project').projectExtra, true);
  assert.equal(readFileSync(f.paths.global, 'utf8'), globalBytes);
});

test('all credentials are masked and same-entry placeholders recursively preserve secrets', async t => {
  const f = fixture(t);
  const raw = { url: 'https://user:password@example.invalid/mcp?access_token=secret', headers: { Authorization: 'Bearer hidden-header', 'X-Anything': 'hidden-other' }, oauth: { clientId: 'public-id', clientSecret: 'hidden-oauth' }, auth: { provider: 'vault', credential: { value: 'hidden-auth' } }, custom: { password: 'hidden-custom', keep: true } };
  f.put('global', { mcpServers: { service: raw, other: { command: 'node', env: { ANY_NAME: 'hidden-env' }, args: ['--token', 'hidden-arg'] } } });
  const view = await readMcpConfigView({ ...f.context, scope: 'global' });
  const config = view.servers.find(s => s.name === 'service').config;
  assert.equal(config.url, hidden);
  assert.equal(config.oauth.clientId, 'public-id');
  assert.equal(config.oauth.clientSecret, hidden);
  assert.equal(config.headers['X-Anything'], hidden);
  assert.equal(config.auth.credential.value, hidden);
  assert.equal(view.servers.find(s => s.name === 'other').config.args, hidden);
  for (const secret of ['password@', 'hidden-header', 'hidden-other', 'hidden-oauth', 'hidden-auth', 'hidden-custom', 'hidden-env', 'hidden-arg']) assert.equal(JSON.stringify(view).includes(secret), false);
  await save(f.context, 'global', 'service', { ...config, enabled: false }, view.revision);
  assert.deepEqual(f.disk('global').mcpServers.service, { ...raw, enabled: false });
  const other = (await readMcpConfigView({ ...f.context, scope: 'global' })).servers.find(s => s.name === 'other');
  await save(f.context, 'global', 'other', { ...other.config, enabled: false });
  assert.equal(f.disk('global').mcpServers.other.env.ANY_NAME, 'hidden-env');
  assert.deepEqual(f.disk('global').mcpServers.other.args, ['--token', 'hidden-arg']);
});

test('placeholder cannot create or copy a credential from another entry or global scope', async t => {
  const f = fixture(t);
  f.put('global', { mcpServers: { existing: { command: 'node', env: { KEY: 'secret' } } } });
  const original = readFileSync(f.paths.global, 'utf8');
  for (const [scope, name, config] of [
    ['global', 'new', { command: 'node', env: { KEY: hidden } }],
    ['global', 'existing', { env: { NEW_KEY: hidden } }],
    ['project', 'existing', { command: 'node', env: { KEY: hidden } }],
    ['global', 'new', { command: 'node', args: [hidden] }],
  ]) await rejects(save(f.context, scope, name, config), 400);
  assert.equal(readFileSync(f.paths.global, 'utf8'), original);
});

test('malformed JSON is never overwritten and errors contain no secret parser fragments', async t => {
  const f = fixture(t);
  const malformed = '{"password":"VERY_PRIVATE_SECRET", "mcpServers":';
  writeFileSync(f.paths.global, malformed);
  const view = await readMcpConfigView({ ...f.context, scope: 'global' });
  assert.equal(view.editable, false); assert.deepEqual(view.servers, []);
  assert.equal(JSON.stringify(view).includes('VERY_PRIVATE_SECRET'), false);
  await assert.rejects(save(f.context, 'global', 'a', { command: 'node' }), error => error.status === 400 && !error.message.includes('VERY_PRIVATE_SECRET'));
  assert.equal(readFileSync(f.paths.global, 'utf8'), malformed);
  for (const doc of [[], { mcpServers: [] }, { mcpServers: { broken: null } }]) {
    f.put('global', doc);
    assert.equal((await readMcpConfigView({ ...f.context, scope: 'global' })).editable, false);
    const bytes = readFileSync(f.paths.global, 'utf8');
    await rejects(save(f.context, 'global', 'new', { command: 'node' }), 400);
    assert.equal(readFileSync(f.paths.global, 'utf8'), bytes);
  }
});

test('revision includes both file bytes and trust and stale save/delete returns 409', async t => {
  const f = fixture(t);
  f.put('global', { mcpServers: { a: { command: 'node' } } });
  const initial = getMcpConfigRevision(f.context);
  assert.match(initial, /^[a-f0-9]{64}$/);
  assert.notEqual(initial, getMcpConfigRevision({ ...f.context, projectTrusted: false }));
  f.put('project', { mcpServers: { a: { enabled: false } } });
  assert.notEqual(initial, getMcpConfigRevision(f.context));
  await rejects(save(f.context, 'global', 'a', { enabled: false }, initial), 409, 'MCP_CONFIG_CONFLICT');
  await rejects(mutateMcpConfig(f.context, { scope: 'global', revision: initial, name: 'a', operation: 'delete' }), 409);
  const current = getMcpConfigRevision(f.context);
  writeFileSync(f.paths.global, readFileSync(f.paths.global, 'utf8') + '\n');
  assert.notEqual(current, getMcpConfigRevision(f.context));
});

test('untrusted project contents are not opened, even malformed or directory config', async t => {
  const f = fixture(t);
  writeFileSync(f.paths.project, 'SECRET INVALID JSON');
  const untrusted = { ...f.context, projectTrusted: false };
  const revision = getMcpConfigRevision(untrusted);
  const view = await readMcpConfigView({ ...untrusted, scope: 'project' });
  assert.equal(view.exists, true); assert.equal(view.path, f.paths.project);
  assert.equal(view.editable, false); assert.deepEqual(view.servers, []); assert.equal(view.error, undefined);
  assert.equal(view.revision, revision);
  writeFileSync(f.paths.project, 'CHANGED SECRET');
  assert.equal(getMcpConfigRevision(untrusted), revision);
  await rejects(save(untrusted, 'project', 'a', { command: 'node' }), 403, 'MCP_PROJECT_UNTRUSTED');
  rmSync(f.paths.project); mkdirSync(f.paths.project);
  assert.equal((await readMcpConfigView({ ...untrusted, scope: 'project' })).error, undefined);
  await save(untrusted, 'global', 'a', { command: 'node' });
});

test('new project overrides accept only enabled/exposure/toolExposure and never inherit secrets', async t => {
  const f = fixture(t);
  f.put('global', { mcpServers: { a: { command: 'node', env: { KEY: 'global-secret' } } } });
  await save(f.context, 'project', 'a', { enabled: false, exposure: 'codemode-deferred', toolExposure: { '*': 'hidden' } });
  assert.deepEqual(f.disk('project').mcpServers.a, { enabled: false, exposure: 'codemode', toolExposure: { '*': 'hidden' } });
  const view = await readMcpConfigView({ ...f.context, scope: 'project' });
  assert.equal(JSON.stringify(view).includes('global-secret'), false);
  for (const config of [{ env: { NEW: 'bad' } }, { oauth: { clientSecret: 'bad' } }, { timeout: 1 }, { vendor: 1 }, { enabled: 'yes' }, { exposure: 'bad' }]) await rejects(save(f.context, 'project', 'override', config), 400);
});

test('core validation rejects invalid transports, types, exposure, timeout and server names', async t => {
  const f = fixture(t);
  for (const config of [{}, { type: 'sse', url: 'https://example.invalid' }, { type: 'other', command: 'node' }, { url: 'file:///etc/test' }, { command: 'node', args: [1] }, { command: 'node', env: { A: 1 } }, { command: 'node', timeout: 0 }, { command: 'node', exposure: 'invalid' }, { command: 'node', toolExposure: { '*': 'invalid' } }, { url: 'https://example.invalid', headers: { A: 1 } }, { url: 'https://example.invalid', oauth: { callbackPort: -1 } }, { url: 'http://example.invalid', auth: { provider: 'vault' } }]) await rejects(save(f.context, 'global', 'valid', config), 400);
  await rejects(save(f.context, 'global', '../escape', { command: 'node' }), 400);
  await save(f.context, 'global', 'http', { url: 'https://example.invalid/mcp?version=1', type: 'streamable-http', timeout: 0.5 });
  await save(f.context, 'global', 'stdio', { type: 'stdio', command: 'node', args: ['server.mjs'], env: { A: '1' } });
});

test('normalized namespaces collide in same scope and across scopes; exact-name overrides work', async t => {
  const f = fixture(t);
  await save(f.context, 'global', 'my-server', { command: 'node' });
  await rejects(save(f.context, 'global', 'my_server', { command: 'node' }), 400);
  await rejects(save(f.context, 'project', 'my_server', { enabled: true }), 400);
  await save(f.context, 'project', 'my-server', { enabled: false });
});

test('stable lock serializes concurrent writes across atomic rename and both scopes', async t => {
  const f = fixture(t);
  const revision = getMcpConfigRevision(f.context);
  const results = await Promise.allSettled([
    save(f.context, 'global', 'one', { command: 'node' }, revision),
    save(f.context, 'project', 'two', { command: 'node' }, revision),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  const revision2 = getMcpConfigRevision(f.context);
  await save(f.context, 'global', 'afterRename', { command: 'node' }, revision2);
  assert.notEqual(getMcpConfigRevision(f.context), revision2);
});

test('delete changes only targeted server and preserves top-level settings', async t => {
  const f = fixture(t);
  f.put('global', { autoEnableCodemode: true, custom: 1, mcpServers: { a: { command: 'node' }, b: { command: 'python' } } });
  await mutateMcpConfig(f.context, { scope: 'global', revision: getMcpConfigRevision(f.context), name: 'a', operation: 'delete' });
  assert.deepEqual(f.disk('global'), { autoEnableCodemode: true, custom: 1, mcpServers: { b: { command: 'python' } } });
});

test('ordinary commands/URLs stay visible and arguments conservatively hide positional credentials', () => {
  assert.deepEqual(redactMcpConfig({ command: 'node', args: ['server.mjs', '--port', '3000'], url: 'https://example.invalid/mcp?version=1' }), { command: 'node', args: hidden, url: 'https://example.invalid/mcp?version=1' });
  assert.equal(redactMcpConfig({ args: ['positional-private-value'] }).args, hidden);
  assert.deepEqual(redactMcpConfig({ args: [] }).args, []);
  for (const config of [{ command: 'node --password=private' }, { url: 'https://u:p@example.invalid' }, { url: 'https://example.invalid?api_key=private' }, { url: 'https://example.invalid?key=private' }, { args: ['--authorization', 'Bearer private'] }, { args: ['--user', 'someone:private'] }, { auth: 'private' }]) assert.equal(Object.values(redactMcpConfig(config))[0], hidden);
});

test('relative directories and missing project cwd are rejected without using caller paths', async t => {
  const f = fixture(t);
  assert.throws(() => getMcpConfigRevision({ ...f.context, agentDir: 'relative' }), e => e.status === 400);
  await rejects(readMcpConfigView({ ...f.context, cwd: 'relative', scope: 'project' }), 400);
  await rejects(save({ agentDir: f.context.agentDir, projectTrusted: true }, 'project', 'a', { command: 'node' }), 400);
  await rejects(save(f.context, 'arbitrary', 'a', { command: 'node' }), 400);
});
