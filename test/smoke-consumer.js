'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

function run(command, args, cwd, { env = process.env, allowFailure = false } = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = String(result.stdout || '').trim();
  if (!allowFailure && (result.error || result.status !== 0)) {
    const detail = String(result.stderr || result.error?.message || output).trim();
    throw new Error(command + ' ' + args.join(' ') + ' failed' + (detail ? ':\n' + detail : '.'));
  }
  return output;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function makeConsumer(root, stackRoot) {
  const consumerStack = path.join(root, 'docker', 'typescript');
  fs.cpSync(stackRoot, consumerStack, {
    recursive: true,
    filter(source) {
      return !source.split(path.sep).includes('.git');
    },
  });
  fs.mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
  writeJson(path.join(root, 'package.json'), {
    name: 'ioweb-typescript-smoke',
    private: true,
    workspaces: ['apps/*'],
    scripts: { build: 'node --version', start: 'node apps/web/server.js' },
  });
  writeJson(path.join(root, 'apps', 'web', 'package.json'), {
    name: '@smoke/web',
    version: '1.0.0',
    private: true,
  });
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'apps', 'web', 'server.js'), [
    "const http = require('node:http');",
    'const port = Number(process.env.PORT || 3100);',
    "http.createServer((request, response) => { if (request.url === '/ready') { response.statusCode = 200; response.end('ready'); return; } if (request.url === '/env') { response.statusCode = 200; response.end(process.env.SMOKE_APP_VALUE || 'missing'); return; } response.statusCode = 404; response.end('not found'); }).listen(port, '0.0.0.0');",
    '',
  ].join('\n'));

  const stack = require(path.join(stackRoot, 'src', 'cli.js'));
  const manifest = stack.defaultManifest();
  manifest.processes = [{
    name: 'web',
    command: 'node server.js',
    directory: 'apps/web',
    container_port: 3100,
    http_port: 80,
    https_port: 443,
  }];
  manifest.healthchecks = [{ name: 'web-ready', process: 'web', path: '/ready' }];
  writeJson(path.join(root, '.ddev', 'ioweb-typescript.json'), manifest);
  stack.renderRuntime(root, { quiet: true });

  const umbrella = require(path.join(process.env.IOWEB_TYPESCRIPT_UMBRELLA_ROOT, 'src', 'ioweb-bootstrap.js'));
  umbrella.ensureDdevFiles(root, {
    ddevProjectName: ('iowebts-' + path.basename(root).slice(-8)).toLowerCase(),
  }, 'typescript', consumerStack);
  run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], root);
}

async function waitForHttp(url, attempts = 30) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
      lastError = new Error('HTTP ' + response.status);
    } catch (error) {
      lastError = error;
    }
    await delay(2000);
  }
  throw new Error('Production application did not become ready: ' + (lastError?.message || 'timeout'));
}

async function smoke({ umbrellaRoot, stackRoot = path.resolve(__dirname, '..') }) {
  process.env.IOWEB_TYPESCRIPT_UMBRELLA_ROOT = path.resolve(umbrellaRoot);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ioweb-typescript-smoke-'));
  const ddevName = ('iowebts-' + path.basename(root).slice(-8)).toLowerCase();
  const composeProject = ('iowebtsprod' + path.basename(root).slice(-7)).toLowerCase();
  const composeFile = path.join(root, 'docker', 'typescript', 'compose.production.yaml');
  const composePrefix = ['compose', '--project-name', composeProject, '--project-directory', root, '-f', composeFile];
  let ddevAttempted = false;
  let composeAttempted = false;

  try {
    makeConsumer(root, path.resolve(stackRoot));
    run('ddev', ['utility', 'configyaml'], root);
    const { ensureDdevNetworkCapacity } = require(path.join(
      path.resolve(umbrellaRoot), 'src', 'ioweb-docker-network-capacity.js',
    ));
    const capacity = ensureDdevNetworkCapacity({ cwd: root, targetProject: ddevName, log: console.log });
    if (!capacity.ok) throw new Error(capacity.error);
    ddevAttempted = true;
    run('ddev', ['start'], root);
    run('ddev', ['npm', 'install', '--no-audit', '--no-fund'], root);
    const nodeVersion = run('ddev', ['exec', 'node', '--version'], root);
    const npmVersion = run('ddev', ['npm', '--version'], root);
    if (!/^v24\./.test(nodeVersion)) throw new Error('DDEV Node.js is not v24: ' + nodeVersion);
    run('ddev', ['exec', 'node', 'docker/typescript/src/cli.js', 'check-health', '--project-root', '/var/www/html', '--quiet'], root);
    console.log('DDEV smoke passed: Node ' + nodeVersion + ', npm ' + npmVersion + ', daemon and health endpoint ready.');
    run('ddev', ['stop'], root);
    run('ddev', ['delete', '--omit-snapshot', '--yes'], root);
    ddevAttempted = false;

    const hostPort = await freePort();
    const env = {
      ...process.env,
      APP_CONTAINER_PORT: '3000',
      APP_HOST_PORT: String(hostPort),
      APP_HEALTHCHECK_URL: 'http://127.0.0.1:3000/ready',
      APP_COMMAND: 'PORT=3000 npm start',
    };
    fs.writeFileSync(path.join(root, '.env.production'), 'SMOKE_APP_VALUE=from-env-file\n');
    run('docker', [...composePrefix, 'config', '--quiet'], root, { env });
    composeAttempted = true;
    run('docker', [...composePrefix, 'up', '--build', '--detach'], root, { env });
    const container = run('docker', [...composePrefix, 'ps', '--quiet', 'app'], root, { env });
    if (!container) throw new Error('Production Compose did not create its app container.');
    let health = 'starting';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      health = run('docker', ['inspect', '--format', '{{.State.Health.Status}}', container], root);
      if (health === 'healthy') break;
      if (health === 'unhealthy') throw new Error('Production container healthcheck failed.');
      await delay(2000);
    }
    if (health !== 'healthy') throw new Error('Production healthcheck timed out: ' + health);
    await waitForHttp('http://127.0.0.1:' + hostPort + '/ready');
    const injected = await fetch('http://127.0.0.1:' + hostPort + '/env');
    if (await injected.text() !== 'from-env-file') throw new Error('Production application variables were not injected from .env.production.');
    console.log('Production smoke passed: multi-stage Docker build, non-root service, HTTP healthcheck, and published route.');
  } finally {
    if (composeAttempted) {
      run('docker', [...composePrefix, 'down', '--volumes', '--remove-orphans', '--rmi', 'local'], root, { allowFailure: true });
    }
    if (ddevAttempted) {
      run('ddev', ['delete', '--omit-snapshot', '--yes'], root, { allowFailure: true });
    }
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (path.resolve(root).startsWith(tempRoot)
      && path.basename(root).startsWith('ioweb-typescript-smoke-')) fs.rmSync(root, { recursive: true, force: true });
    delete process.env.IOWEB_TYPESCRIPT_UMBRELLA_ROOT;
  }
}

if (require.main === module) {
  const umbrellaRoot = process.argv[2];
  if (!umbrellaRoot) {
    console.error('Usage: node test/smoke-consumer.js <docker-development-stacks-root>');
    process.exitCode = 2;
  } else {
    smoke({ umbrellaRoot }).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}

module.exports = { makeConsumer, smoke };
