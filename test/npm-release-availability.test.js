import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {checkRelease} from '../scripts/npm-release-availability.mjs';
const release = {name: 'cloudgpu-mcp', version: '0.99.0'};
const response = (status, body) => ({status, json: async () => body});
const pack = {name: release.name, versions: {'0.16.6': {version: '0.16.6'}}};

test('published exact version runs image acceptance without using latest', async () => {
  const calls = [];
  assert.equal(await checkRelease(release, {fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    return response(200, release);
  }}), true);
  assert.deepEqual(calls, ['https://registry.npmjs.org/cloudgpu-mcp/0.99.0']);
});

test('E404 skips only after successful package metadata confirms exact version absent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-release-test-'));
  try {
    const env = {GITHUB_OUTPUT: path.join(dir, 'output'), GITHUB_STEP_SUMMARY: path.join(dir, 'summary')};
    const calls = [];
    assert.equal(await checkRelease(release, {env, fetchImpl: async url => {
      calls.push(url); return calls.length === 1 ? response(404, {error: 'version not found'}) : response(200, pack);
    }}), false);
    assert.deepEqual(calls, ['https://registry.npmjs.org/cloudgpu-mcp/0.99.0', 'https://registry.npmjs.org/cloudgpu-mcp']);
    assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'published=false\n');
    assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /SKIPPED.*0\.99\.0.*not published/);
    assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /No image build or smoke acceptance was performed/);
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});

test('network, timeout, authorization, rate limit and server errors never become an unpublished skip', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(checkRelease(release, {fetchImpl: async () => response(status)}), /lookup failed/);
  }
  for (const message of ['network unavailable', 'request timed out']) {
    await assert.rejects(checkRelease(release, {fetchImpl: async () => {throw new Error(message);}}), new RegExp(message));
  }
});

test('E404 with missing package, broken metadata or inconsistent exact version fails closed', async () => {
  for (const fallback of [response(404), response(403), response(503),
    response(200, {}), response(200, {...pack, versions: []}),
    response(200, {...pack, versions: {[release.version]: release}})]) {
    let calls = 0;
    await assert.rejects(checkRelease(release, {fetchImpl: async () => ++calls === 1 ? response(404) : fallback}));
  }
  let calls = 0;
  await assert.rejects(checkRelease(release, {fetchImpl: async () => {
    if (++calls === 1) return response(404);
    throw new Error('fallback network failure');
  }}), /network failure/);
  await assert.rejects(checkRelease(release, {fetchImpl: async () => response(200, {...release, version: '0.16.6'})}), /identity mismatch/);
  await assert.rejects(checkRelease(release, {fetchImpl: async () => ({status: 200, json: async () => {throw new Error('invalid JSON');}})}), /invalid JSON/);
});
