'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const stack = require('../src/cli');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ioweb-typescript-'));
  fs.mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'shared'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
  return root;
}

function writeManifest(root, overrides = {}) {
  const manifest = {
    ...stack.defaultManifest(),
    processes: [{ name: 'web', command: 'npm run dev --workspace=@example/web', directory: 'apps/web', container_port: 3100, http_port: 80, https_port: 443 }],
    healthchecks: [{ name: 'web-ready', process: 'web', path: '/ready' }],
    ...overrides,
  };
  const destination = path.join(root, '.ddev', 'ioweb-typescript.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(manifest, null, 2));
  return manifest;
}

test('Node 24 is centralized in the stack version file and Docker build default', () => {
  const configured = stack.STACK_CONFIG.node_version;
  assert.equal(configured, fs.readFileSync(path.join(__dirname, '..', '.nvmrc'), 'utf8').trim());
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8'), new RegExp(`ARG NODE_VERSION=${configured}`));
  assert.equal(stack.defaultManifest().node_version, configured);
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'compose.production.yaml'), 'utf8').includes('NODE_VERSION: ${NODE_VERSION:-' + configured + '}'));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'Dockerfile.dockerignore'), 'utf8'), /\*\*\/node_modules/);
});

test('default consumer manifest is framework-neutral and supports workspaces', () => {
  const root = fixture();
  try {
    writeManifest(root, {
      processes: [
        { name: 'web', command: 'npm run dev --workspace=@example/web', directory: 'apps/web', container_port: 3100, http_port: 80, https_port: 443 },
        { name: 'api', command: 'npm run dev --workspace=@example/api', directory: 'apps/api', container_port: 4100, http_port: 8099, https_port: 8499 },
        { name: 'worker', command: 'npm run worker --workspace=@example/api' },
      ],
      volume_paths: [...stack.DEFAULT_VOLUME_PATHS, 'apps/web/node_modules', 'apps/web/.next', 'packages/shared/node_modules'],
      healthchecks: [{ name: 'web-live', process: 'web', path: '/health' }, { name: 'api-ready', process: 'api', path: '/ready' }],
    });
    assert.doesNotThrow(() => stack.readManifest(root));
    const rendered = stack.renderRuntime(root, { quiet: true });
    const config = fs.readFileSync(rendered.configPath, 'utf8');
    const compose = fs.readFileSync(rendered.composePath, 'utf8');
    assert.match(config, /web_extra_daemons:/);
    assert.match(config, /web_extra_exposed_ports:/);
    assert.match(config, /container_port: 4100/);
    assert.match(config, /\/var\/www\/html\/apps\/web/);
    assert.match(compose, /typescript_apps_web_node_modules:.*apps\/web\/node_modules/);
    assert.match(compose, /typescript_apps_web_next:.*apps\/web\/\.next/);
    assert.match(compose, /typescript_data:\/var\/www\/html\/data/);
    assert.equal(stack.renderRuntime(root, { quiet: true }).changed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('worker processes need no HTTP port and no framework command is assumed', () => {
  const manifest = {
    ...stack.defaultManifest(),
    processes: [{ name: 'worker', command: 'npm run worker --workspace=@example/worker', directory: 'apps/worker' }],
  };
  assert.match(stack.renderDdevConfig(manifest), /command: 'npm run worker --workspace=@example\/worker'/);
  assert.doesNotMatch(stack.renderDdevConfig(manifest), /web_extra_exposed_ports/);
});

test('invalid paths, incomplete ports, duplicate names, and overlapping volumes are rejected', () => {
  const base = stack.defaultManifest();
  assert.throws(() => stack.validateManifest({ ...base, persistent_paths: ['../outside'] }), /stay inside/);
  assert.throws(() => stack.validateManifest({ ...base, processes: [{ name: 'web', command: 'npm run dev', container_port: 3000 }] }), /set container_port, http_port, and https_port together/);
  assert.throws(() => stack.validateManifest({ ...base, volume_paths: ['node_modules', 'node_modules/cache'] }), /must not overlap/);
  assert.throws(() => stack.validateManifest({ ...base, volume_paths: ['a.b', 'a_b'] }), /volume names collide/);
  assert.throws(() => stack.validateManifest({ ...base, processes: [
    { name: 'web', command: 'npm run web', container_port: 3100, http_port: 80, https_port: 443 },
    { name: 'api', command: 'npm run api', container_port: 4100, http_port: 80, https_port: 444 },
  ] }), /values must be unique/);
  assert.throws(() => stack.validateManifest({ ...base, processes: [{ name: 'web', command: 'npm run dev' }, { name: 'web', command: 'npm start' }] }), /duplicated/);
});

test('renderer refuses unmanaged runtime files and never overwrites consumer config', () => {
  const root = fixture();
  try {
    const manifestPath = path.join(root, '.ddev', 'ioweb-typescript.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(stack.defaultManifest()));
    const runtimePath = path.join(root, '.ddev', 'config.ioweb-typescript-runtime.yaml');
    fs.writeFileSync(runtimePath, 'consumer owned\n');
    assert.throws(() => stack.renderRuntime(root, { quiet: true }), /Refusing to overwrite unmanaged/);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), JSON.stringify(stack.defaultManifest()));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('healthcheck probes consumer-selected paths and expected statuses', async () => {
  const server = http.createServer((request, response) => {
    response.statusCode = request.url === '/ready' ? 204 : 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const manifest = {
      ...stack.defaultManifest(),
      processes: [{ name: 'api', command: 'node app.js' }],
      healthchecks: [{ name: 'api-ready', process: 'api', port, path: '/ready', expected_statuses: [204] }],
    };
    assert.equal((await stack.probeHealthcheck(manifest.healthchecks[0], manifest)).status, 204);
    await assert.rejects(stack.probeHealthcheck({ ...manifest.healthchecks[0], path: '/missing' }, manifest), /HTTP 404/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('runtime fragments mount persistent data and keep high-churn worktree paths in Docker volumes', () => {
  const manifest = stack.defaultManifest();
  const compose = stack.renderDdevCompose(manifest);
  assert.match(compose, /typescript_node_modules:\/var\/www\/html\/node_modules/);
  assert.match(compose, /typescript_next:\/var\/www\/html\/\.next/);
  assert.match(compose, /typescript_data:\/var\/www\/html\/data/);
  assert.match(stack.renderDdevConfig(manifest), /fail_on_hook_fail: true/);
});
