#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STACK_ROOT = path.resolve(__dirname, '..');
const STACK_CONFIG = JSON.parse(fs.readFileSync(path.join(STACK_ROOT, 'stack.config.json'), 'utf8'));
const DDEV_CONFIG_MARKER = '# ioweb-managed: docker-bootstrap TypeScript DDEV runtime v1';
const DDEV_COMPOSE_MARKER = '# ioweb-managed: docker-bootstrap TypeScript DDEV volumes v1';
const DEFAULT_VOLUME_PATHS = Object.freeze([
  'node_modules', '.next', 'dist', 'build', 'coverage', '.cache', '.turbo', '.vite',
]);

function usage() {
  return [
    'Usage: node docker/typescript/src/cli.js <command> [options]',
    '',
    'Commands:',
    '  render-runtime  Generate the consumer DDEV process and volume fragments',
    '  validate        Validate the consumer runtime manifest',
    '  check-health    Probe application health endpoints declared by the consumer',
    '',
    'Options:',
    '  --project-root DIR   Consumer checkout root; defaults to the current directory',
    '  --force              Replace unmanaged generated DDEV fragments',
    '  --quiet              Suppress success output',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') { options.help = true; continue; }
    if (token === '--force' || token === '--quiet') { options[token.slice(2)] = true; continue; }
    if (token === '--project-root') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('--project-root requires a directory.');
      options.projectRoot = argv[++index];
      continue;
    }
    if (token.startsWith('--')) throw new Error(`Unknown option: ${token}`);
    options._.push(token);
  }
  return options;
}

function resolveProjectRoot(value) {
  const root = path.resolve(value || process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Project root is not a directory: ${root}`);
  return root;
}

function relativeProjectPath(value, label, { allowRoot = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty project-relative path.`);
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (allowRoot && (!normalized || normalized === '.')) return '.';
  if (!normalized || normalized === '.' || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9@._-]+$/.test(segment))) {
    throw new Error(`${label} must stay inside the consumer project: ${value}`);
  }
  return normalized;
}

function validPort(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${label} must be an integer from 1 to 65535.`);
  return value;
}

function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TypeScript consumer config must be a JSON object.');
  const keys = new Set(['$schema', 'node_version', 'processes', 'volume_paths', 'persistent_paths', 'healthchecks']);
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new Error(`Unsupported TypeScript consumer config property: ${key}`);
  if (value.node_version !== undefined && (typeof value.node_version !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.node_version))) {
    throw new Error('node_version must be a Node major or major.minor version string.');
  }
  for (const key of ['processes', 'volume_paths', 'persistent_paths', 'healthchecks']) {
    if (!Array.isArray(value[key])) throw new Error(`${key} must be an array.`);
  }
  const processNames = new Set();
  for (const process of value.processes) {
    if (!process || typeof process !== 'object' || Array.isArray(process)) throw new Error('Each process must be an object.');
    const processKeys = new Set(['name', 'command', 'directory', 'container_port', 'http_port', 'https_port']);
    for (const key of Object.keys(process)) if (!processKeys.has(key)) throw new Error(`Unsupported process property: ${key}`);
    if (typeof process.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(process.name)) throw new Error('Process names must start with a letter and contain only letters, numbers, underscores, or hyphens.');
    if (processNames.has(process.name)) throw new Error(`Process name is duplicated: ${process.name}`);
    processNames.add(process.name);
    if (typeof process.command !== 'string' || !process.command.trim() || /[\r\n\0]/.test(process.command)) throw new Error(`Process ${process.name} requires a single-line command.`);
    if (process.directory !== undefined) relativeProjectPath(process.directory, `Process ${process.name} directory`, { allowRoot: true });
    const portKeys = ['container_port', 'http_port', 'https_port'];
    const hasAnyPort = portKeys.some((key) => process[key] !== undefined);
    const hasAllPorts = portKeys.every((key) => process[key] !== undefined);
    if (hasAnyPort !== hasAllPorts) throw new Error(`Process ${process.name} must set container_port, http_port, and https_port together for DDEV routing.`);
    if (hasAllPorts) for (const key of portKeys) validPort(process[key], `Process ${process.name} ${key}`);
  }
  const routePorts = value.processes.flatMap((process) => process.container_port === undefined ? [] : [process.http_port, process.https_port]);
  if (new Set(routePorts).size !== routePorts.length) throw new Error('DDEV http_port and https_port values must be unique across processes.');
  const volumePaths = [...value.volume_paths, ...value.persistent_paths].map((item, index) => relativeProjectPath(item, `volume_paths/persistent_paths[${index}]`));
  if (new Set(volumePaths).size !== volumePaths.length) throw new Error('volume_paths and persistent_paths must not overlap or contain duplicates.');
  for (let left = 0; left < volumePaths.length; left += 1) {
    for (let right = left + 1; right < volumePaths.length; right += 1) {
      if (volumePaths[left].startsWith(`${volumePaths[right]}/`) || volumePaths[right].startsWith(`${volumePaths[left]}/`)) {
        throw new Error(`Docker volume paths must not overlap: ${volumePaths[left]} and ${volumePaths[right]}`);
      }
    }
  }
  const volumeNames = volumePaths.map(volumeName);
  if (new Set(volumeNames).size !== volumeNames.length) throw new Error('Docker volume names collide after path normalization.');
  const healthNames = new Set();
  for (const health of value.healthchecks) {
    if (!health || typeof health !== 'object' || Array.isArray(health)) throw new Error('Each healthcheck must be an object.');
    for (const key of Object.keys(health)) if (!['name', 'process', 'path', 'port', 'expected_statuses'].includes(key)) throw new Error(`Unsupported healthcheck property: ${key}`);
    if (typeof health.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(health.name)) throw new Error('Healthcheck names must start with a letter and contain only letters, numbers, underscores, or hyphens.');
    if (healthNames.has(health.name)) throw new Error(`Healthcheck name is duplicated: ${health.name}`);
    healthNames.add(health.name);
    if (!processNames.has(health.process)) throw new Error(`Healthcheck ${health.name} refers to an unknown process: ${health.process}`);
    if (typeof health.path !== 'string' || !/^\/[^\s]*$/.test(health.path)) throw new Error(`Healthcheck ${health.name} path must start with / and contain no whitespace.`);
    if (health.port !== undefined) validPort(health.port, `Healthcheck ${health.name} port`);
    else {
      const process = value.processes.find((candidate) => candidate.name === health.process);
      if (!process.container_port) throw new Error(`Healthcheck ${health.name} requires a port because process ${health.process} has no routed container_port.`);
    }
    if (health.expected_statuses !== undefined
      && (!Array.isArray(health.expected_statuses) || !health.expected_statuses.length
        || health.expected_statuses.some((status) => !Number.isInteger(status) || status < 100 || status > 599))) {
      throw new Error(`Healthcheck ${health.name} expected_statuses must contain HTTP status integers from 100 to 599.`);
    }
  }
  return value;
}

function consumerConfigPath(projectRoot) {
  return path.join(projectRoot, STACK_CONFIG.consumer_config);
}

function defaultManifest() {
  return {
    $schema: '../docker/typescript/schemas/consumer-config.schema.json',
    node_version: STACK_CONFIG.node_version,
    processes: [],
    volume_paths: [...DEFAULT_VOLUME_PATHS],
    persistent_paths: ['data'],
    healthchecks: [],
  };
}

function readManifest(projectRoot, { create = false } = {}) {
  const destination = consumerConfigPath(projectRoot);
  if (!fs.existsSync(destination)) {
    if (!create) throw new Error(`Missing ${path.relative(projectRoot, destination)}; run docker-bootstrap or ioweb-typescript render-runtime.`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const initial = defaultManifest();
    fs.writeFileSync(destination, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');
    return validateManifest(initial);
  }
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(destination, 'utf8').replace(/^#.*\r?\n/, '')); }
  catch (error) { throw new Error(`Invalid TypeScript consumer config ${destination}: ${error.message}`); }
  return validateManifest(parsed);
}

function yamlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function volumeName(relativePath) {
  return `typescript_${relativePath.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

function renderDdevConfig(manifest) {
  const lines = [DDEV_CONFIG_MARKER, '# Consumer commands and ports are read from .ddev/ioweb-typescript.json.'];
  const daemonProcesses = manifest.processes;
  const routableProcesses = daemonProcesses.filter((process) => process.container_port !== undefined);
  if (daemonProcesses.length) {
    lines.push('web_extra_daemons:');
    for (const process of daemonProcesses) {
      lines.push(`  - name: ${yamlQuote(process.name)}`);
      lines.push(`    command: ${yamlQuote(process.command)}`);
      lines.push(`    directory: ${yamlQuote(`/var/www/html${process.directory && process.directory !== '.' ? `/${relativeProjectPath(process.directory, 'Process directory')}` : ''}`)}`);
    }
  }
  if (routableProcesses.length) {
    lines.push('web_extra_exposed_ports:');
    for (const process of routableProcesses) {
      lines.push(`  - name: ${yamlQuote(process.name)}`);
      lines.push(`    container_port: ${process.container_port}`);
      lines.push(`    http_port: ${process.http_port}`);
      lines.push(`    https_port: ${process.https_port}`);
    }
  }
  const volumePaths = [...manifest.volume_paths, ...manifest.persistent_paths];
  if (volumePaths.length) {
    const directories = volumePaths.map((value) => `/var/www/html/${relativeProjectPath(value, 'Volume path')}`);
    const command = `mkdir -p ${directories.join(' ')} && chown \${DDEV_UID}:\${DDEV_GID} ${directories.join(' ')} && chmod u+rwx,g+rwx,o+rx,o-w ${directories.join(' ')}`;
    lines.push('hooks:', '  post-start:', `    - exec: ${yamlQuote(command)}`, '      user: root', 'fail_on_hook_fail: true');
  }
  lines.push('');
  return lines.join('\n');
}

function renderDdevCompose(manifest) {
  const paths = [...manifest.volume_paths, ...manifest.persistent_paths];
  const lines = [DDEV_COMPOSE_MARKER, '# Docker volumes keep Node dependencies, build output, caches, and consumer data off the Windows checkout.'];
  if (!paths.length) return `${lines.join('\n')}\n`;
  lines.push('services:', '  web:', '    volumes:');
  for (const relative of paths) lines.push(`      - ${volumeName(relative)}:/var/www/html/${relativeProjectPath(relative, 'Volume path')}`);
  lines.push('volumes:');
  for (const relative of paths) lines.push(`  ${volumeName(relative)}:`);
  lines.push('');
  return lines.join('\n');
}

function managedWrite(destination, content, marker, force = false) {
  const existing = fs.existsSync(destination) ? fs.readFileSync(destination, 'utf8') : '';
  if (existing && !existing.includes(marker) && !force) throw new Error(`Refusing to overwrite unmanaged TypeScript runtime file: ${destination}`);
  if (existing.replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n')) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, 'utf8');
  return true;
}

function renderRuntime(projectRoot, options = {}) {
  const manifest = readManifest(projectRoot, { create: true });
  const configPath = path.join(projectRoot, STACK_CONFIG.ddev_runtime_config);
  const composePath = path.join(projectRoot, STACK_CONFIG.ddev_runtime_compose);
  const changed = [
    managedWrite(configPath, renderDdevConfig(manifest), DDEV_CONFIG_MARKER, options.force),
    managedWrite(composePath, renderDdevCompose(manifest), DDEV_COMPOSE_MARKER, options.force),
  ];
  if (!options.quiet) console.log(`[typescript] ${changed.some(Boolean) ? 'reconciled' : 'runtime files already current'} .ddev`);
  return { configPath, composePath, changed: changed.some(Boolean) };
}

async function probeHealthcheck(health, manifest, { timeoutMs = 5000 } = {}) {
  const process = manifest.processes.find((candidate) => candidate.name === health.process);
  const port = health.port || process.container_port;
  const statuses = health.expected_statuses || [200];
  const url = `http://127.0.0.1:${port}${health.path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!statuses.includes(response.status)) throw new Error(`${url} returned HTTP ${response.status}; expected ${statuses.join(', ')}.`);
    return { name: health.name, url, status: response.status };
  } catch (error) {
    throw new Error(`${health.name}: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function checkHealth(projectRoot, options = {}) {
  const manifest = readManifest(projectRoot);
  if (!manifest.healthchecks.length) {
    if (!options.quiet) console.log('[typescript] no application healthchecks are declared by the consumer');
    return { skipped: true, results: [] };
  }
  const results = [];
  for (const health of manifest.healthchecks) results.push(await probeHealthcheck(health, manifest));
  if (!options.quiet) for (const result of results) console.log(`[typescript] ${result.name}: HTTP ${result.status} ${result.url}`);
  return { skipped: false, results };
}

async function run(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) { console.log(usage()); return 0; }
    const command = options._[0];
    if (!['render-runtime', 'validate', 'check-health'].includes(command)) throw new Error(usage());
    const root = resolveProjectRoot(options.projectRoot);
    if (command === 'render-runtime') renderRuntime(root, options);
    else if (command === 'validate') {
      readManifest(root);
      if (!options.quiet) console.log('[typescript] consumer runtime config is valid');
    } else await checkHealth(root, options);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (require.main === module) run().then((code) => { process.exitCode = code; });

module.exports = {
  DEFAULT_VOLUME_PATHS,
  STACK_CONFIG,
  checkHealth,
  defaultManifest,
  parseArgs,
  probeHealthcheck,
  readManifest,
  renderDdevCompose,
  renderDdevConfig,
  renderRuntime,
  run,
  validateManifest,
};
