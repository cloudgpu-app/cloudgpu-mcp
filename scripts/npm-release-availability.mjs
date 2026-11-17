// A not-yet-published release may skip image acceptance; lookup failures must fail CI.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

export async function checkRelease({name, version}, {fetchImpl = fetch, env = {}} = {}) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  const get = target => fetchImpl(target, {redirect: 'error', signal: AbortSignal.timeout(15000)});
  const exact = await get(`${url}/${encodeURIComponent(version)}`);
  let published;
  if (exact.status === 200) {
    const record = await exact.json();
    if (record.name !== name || record.version !== version) throw new Error('npm version identity mismatch');
    published = true;
  } else if (exact.status === 404) {
    // A 404 alone could mean a missing package or an unexpected registry response.
    // Require successful package metadata confirming this exact version is absent.
    const response = await get(url);
    if (response.status !== 200) throw new Error(`npm package lookup failed: HTTP ${response.status}`);
    const pack = await response.json();
    if (pack.name !== name || !pack.versions || typeof pack.versions !== 'object' || Array.isArray(pack.versions)) {
      throw new Error('Invalid npm package metadata');
    }
    if (Object.hasOwn(pack.versions, version)) throw new Error('Inconsistent npm version lookup');
    published = false;
  } else {
    throw new Error(`npm exact version lookup failed: HTTP ${exact.status}`);
  }
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `published=${published}\n`);
  if (!published) {
    const message = `Docker image smoke SKIPPED: ${name}@${version} is not published on npm. No image build or smoke acceptance was performed. Metadata and unit tests still run.\n`;
    console.log(message.trim());
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, message);
  }
  return published;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkRelease(JSON.parse(fs.readFileSync('package.json', 'utf8')), {env: process.env});
  } catch (error) {
    console.error(`npm availability check failed; image acceptance is not skipped: ${error.message}`);
    process.exitCode = 1;
  }
}
