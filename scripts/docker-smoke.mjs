// Compare the built image with an independently installed published npm package.
// Only initialize, initialized and tools/list are sent; never tools/call.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const [image, baselineDir] = process.argv.slice(2);
assert.ok(image && baselineDir, 'Usage: node scripts/docker-smoke.mjs IMAGE NPM_PREFIX');
const {version} = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const baseline = path.resolve(baselineDir, 'node_modules/cloudgpu-mcp');
assert.equal(JSON.parse(fs.readFileSync(path.join(baseline, 'package.json'), 'utf8')).version, version);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgpu-image-smoke-'));
const containers = new Set();
function docker(args) {
  const result = spawnSync('docker', args, {encoding: 'utf8', timeout: 15000});
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout.trim();
}
function cleanup() {
  for (const name of containers) spawnSync('docker', ['rm', '-f', name], {timeout: 15000, stdio: 'ignore'});
  fs.rmSync(temporary, {recursive: true, force: true});
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {cleanup(); process.exit(1);});

async function discover(command, args, env) {
  const transport = new StdioClientTransport({command, args, env, stderr: 'pipe'});
  let stderr = '';
  transport.stderr.on('data', data => {stderr = (stderr + data).slice(-8192);});
  const client = new Client({name: 'docker-image-smoke', version: '1.0.0'});
  try {
    await client.connect(transport, {timeout: 15000});
    assert.deepEqual(client.getServerVersion(), {name: 'cloudgpu', version});
    const tools = [];
    let cursor;
    do {
      const result = await client.listTools(cursor ? {cursor} : {}, {timeout: 15000});
      tools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);
    assert.ok(tools.length > 0, 'tools/list must not be empty');
    assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length);
    return tools.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    throw new Error(`${command} stdio discovery failed: ${error.message}\n${stderr}`, {cause: error});
  } finally {
    await client.close();
    await transport.close();
  }
}

try {
  for (const readOnly of ['0', '1']) {
    const env = {
      PATH: process.env.PATH,
      CLOUDGPU_API_KEY: 'dummy-image-smoke-not-a-real-key',
      CLOUDGPU_BASE_URL: 'http://127.0.0.1:9',
      CLOUDGPU_CONFIG_DIR: path.join(temporary, `empty-${readOnly}`),
      CLOUDGPU_READ_ONLY: readOnly,
    };
    const expected = await discover(process.execPath, [path.join(baseline, 'src/index.js')], env);
    const name = `cloudgpu-smoke-${process.pid}-${readOnly}`;
    containers.add(name);
    // No host mounts, credentials or network. Keep the stopped container to check its exit.
    const args = ['run', '--name', name, '--network', 'none', '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '-i'];
    for (const [key, value] of Object.entries({...env, CLOUDGPU_CONFIG_DIR: '/tmp/empty-config'})) {
      if (key !== 'PATH') args.push('-e', `${key}=${value}`);
    }
    args.push(image);
    try {
      const actual = await discover('docker', args, {PATH: process.env.PATH});
      assert.deepEqual(actual, expected, `Published npm tool names/schemas differ (readOnly=${readOnly})`);
      const state = JSON.parse(docker(['inspect', '--format', '{{json .State}}', name]));
      assert.equal(state.Running, false, 'Container must exit after stdin closes');
      assert.equal(state.ExitCode, 0, 'Container must shut down cleanly');
      console.log(`Image ${version}: readOnly=${readOnly}, ${actual.length} tools match published npm names and full schemas; clean exit`);
    } finally {
      docker(['rm', '-f', name]);
      containers.delete(name);
    }
  }
} finally {
  cleanup();
}
