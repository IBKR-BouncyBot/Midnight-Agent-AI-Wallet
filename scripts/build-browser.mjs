import { build } from 'esbuild';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { browserWasmPlugin } from './browser-wasm-plugin.mjs';

const root = resolve(import.meta.dirname, '..'), out = join(root, 'dist');
const probe = process.argv.includes('--probe');
const payProbe = process.argv.includes('--pay-probe');
if (payProbe && !probe) throw new Error('--pay-probe requires --probe');
await mkdir(out, { recursive: true });
const assets = new Map();
const entries = { 'proof-worker': 'packages/browser-prover/worker.mjs',
  ...(probe ? { 'proof-probe': 'packages/browser-prover/probe.mjs', 'storage-probe':'packages/browser-storage/probe.mjs', 'observer-probe':'packages/browser-demo/observer-probe.mjs' } : { 'testnet-app': 'web/testnet.mjs' }) };
for (const [name, entry] of Object.entries(entries)) {
  const result = await build({ absWorkingDir: root, entryPoints: [join(root, entry)], outfile: join(out, `${name}.mjs`),
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022', conditions: ['browser', 'import'], mainFields: ['browser', 'module', 'main'],
    inject: [join(root, 'scripts/browser-globals.mjs')], plugins: [browserWasmPlugin(root, assets)],
    define: { 'process.env.NODE_ENV': '"production"' }, metafile: true, sourcemap: false, legalComments: 'inline', logLevel: 'warning' });
  if (result.warnings.length || Object.values(result.metafile.outputs).some(item => item.imports.some(value => value.external))) throw new Error('Browser bundle needs review');
}
const hashes = {};
const publicManifest = JSON.parse(await readFile(join(root, 'scripts/browser-artifacts.json'), 'utf8'));
for (const [path, expected] of Object.entries(publicManifest.files)) {
  if (!/^(?:(?:zswap|dust)\/9\/(?:spend|output|sign)\.(?:prover|verifier|bzkir)|bls_midnight_2p\d+)$/.test(path)) throw new Error('Unexpected public artifact path');
  const bytes = await readFile(join(root, '.tools/browser-public-artifacts', path));
  if (bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new Error('Public artifact hash mismatch');
  const relative = `browser-builtins/${path}`;
  await mkdir(join(out, relative, '..'), { recursive: true });
  await writeFile(join(out, relative), bytes); hashes[relative] = expected.sha256;
}
for (const contract of ['private-vault', 'test-token']) {
  for (const directory of ['keys', 'zkir']) {
    await mkdir(join(out, 'browser-contracts', contract, directory), { recursive: true });
    const { readdir } = await import('node:fs/promises');
    for (const name of await readdir(join(root, 'contracts/managed', contract, directory))) {
      if (!/\.(prover|verifier|bzkir)$/.test(name)) continue;
      const bytes = await readFile(join(root, 'contracts/managed', contract, directory, name));
      const path = `browser-contracts/${contract}/${directory}/${name}`;
      await writeFile(join(out, path), bytes); hashes[path] = createHash('sha256').update(bytes).digest('hex');
    }
  }
}
await mkdir(join(out, 'browser-assets'), { recursive: true });
for (const [file, bytes] of assets) await writeFile(join(out, file), bytes);
await writeFile(join(out, 'browser-build.json'), JSON.stringify({ version: 1, proving: 'wasm-worker', hashes }, null, 2) + '\n');
if (probe) {
  await writeFile(join(out,'observer-probe.html'),`<!doctype html><meta charset="utf-8"><title>Browser recipient check</title><h1>Actual Preview recipient observer</h1><button id="run">Check public Preview sync</button><p id="stage">Ready</p><pre id="result"></pre><script type="module" src="./observer-probe-ui.mjs"></script>`);
  await writeFile(join(out,'observer-probe-ui.mjs'),`import {runBrowserObserverProbe} from './observer-probe.mjs';document.querySelector('#run').onclick=async()=>{document.querySelector('#run').disabled=true;try{const r=await runBrowserObserverProbe({enabled:true,onStage:s=>document.querySelector('#stage').textContent=s});document.querySelector('#result').textContent=JSON.stringify(r,null,2);document.querySelector('#stage').textContent='Complete';}catch(e){document.querySelector('#stage').textContent='Failed';document.querySelector('#result').textContent=e.code||'OBSERVER_CHECK_FAILED';}document.querySelector('#run').disabled=false;};`);
  if (payProbe) {
    await cp(join(root,'.local/browser-prover-fixture/pay.preimage.bin'),join(out,'pay.preimage.bin'));
    await writeFile(join(out,'pay-probe.html'),`<!doctype html><meta charset="utf-8"><title>Browser payment proof check</title><h1>Actual browser payment proof</h1><button id="run">Generate payment proof</button><p id="stage">Ready</p><pre id="result"></pre><script type="module" src="./pay-probe-ui.mjs"></script>`);
    await writeFile(join(out,'pay-probe-ui.mjs'),`import {runBrowserProofProbe} from './proof-probe.mjs';document.querySelector('#run').onclick=async()=>{document.querySelector('#run').disabled=true;try{const r=await runBrowserProofProbe({workerUrl:'./proof-worker.mjs',contractBase:'./browser-contracts/private-vault/',fixtureUrl:'./pay.preimage.bin',contractName:'private-vault',circuit:'pay',onStage:s=>document.querySelector('#stage').textContent=s});document.querySelector('#result').textContent=JSON.stringify(r,null,2);document.querySelector('#stage').textContent='Complete';}catch(e){document.querySelector('#stage').textContent='Failed';document.querySelector('#result').textContent=e.code||'PROOF_FAILED';}document.querySelector('#run').disabled=false;};`);
  }
  await writeFile(join(out, 'storage-probe.html'), `<!doctype html><meta charset="utf-8"><title>Browser storage check</title><h1>Actual encrypted browser storage</h1><button id="run">Test backup and recovery</button><p id="stage">Ready</p><pre id="result"></pre><script type="module" src="./storage-probe-ui.mjs"></script>`);
  await writeFile(join(out, 'storage-probe-ui.mjs'), `import {runBrowserStorageProbe} from './storage-probe.mjs';document.querySelector('#run').onclick=async()=>{document.querySelector('#run').disabled=true;try{const r=await runBrowserStorageProbe({enabled:true});document.querySelector('#result').textContent=JSON.stringify(r,null,2);document.querySelector('#stage').textContent='Complete';}catch(e){document.querySelector('#stage').textContent='Failed';document.querySelector('#result').textContent=e.code||'STORAGE_CHECK_FAILED';}document.querySelector('#run').disabled=false;};`);
  await cp(join(root, '.local/browser-prover-fixture/mint.preimage.bin'), join(out, 'mint.preimage.bin'));
  await writeFile(join(out, 'proof-probe.html'), `<!doctype html><meta charset="utf-8"><title>Browser proof check</title><h1>Actual browser WASM proof</h1><button id="run">Generate test proof</button><p id="stage">Ready</p><pre id="result"></pre><script type="module" src="./proof-probe-ui.mjs"></script>`);
  await writeFile(join(out, 'proof-probe-ui.mjs'), `import { runBrowserProofProbe } from './proof-probe.mjs';document.querySelector('#run').onclick=async()=>{document.querySelector('#run').disabled=true;try{const r=await runBrowserProofProbe({workerUrl:'./proof-worker.mjs',contractBase:'./browser-contracts/test-token/',fixtureUrl:'./mint.preimage.bin',onStage:s=>document.querySelector('#stage').textContent=s});document.querySelector('#result').textContent=JSON.stringify(r,null,2);document.querySelector('#stage').textContent='Complete';}catch(e){document.querySelector('#stage').textContent='Failed';document.querySelector('#result').textContent=e.code||'PROOF_FAILED';}document.querySelector('#run').disabled=false;};`);
} else {
  const page = join(out, 'testnet.html');
  await writeFile(page, (await readFile(page, 'utf8')).replace('src="./testnet.mjs"', 'src="./testnet-app.mjs"'));
  // The bundled entry is the only production copy; probes are local-only.
  for (const name of ['testnet.mjs', 'proof-probe.html', 'proof-probe-ui.mjs', 'proof-probe.mjs', 'mint.preimage.bin', 'pay.preimage.bin','pay-probe.html','pay-probe-ui.mjs','storage-probe.html','storage-probe-ui.mjs','storage-probe.mjs','observer-probe.html','observer-probe-ui.mjs','observer-probe.mjs']) await rm(join(out, name), { force: true });
}
console.log(`Built real browser WASM with ${assets.size} binaries and ${Object.keys(hashes).length} circuit assets.`);
