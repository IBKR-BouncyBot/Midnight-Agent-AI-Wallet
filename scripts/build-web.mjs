import { cp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'web');
const target = resolve(root, 'dist');
const allowed = new Set(['.html', '.css', '.js', '.mjs', '.svg', '.png', '.woff2', '.txt', '.md']);
// Only this fixed generated directory may be cleared; never a caller-supplied path.
if (target !== resolve(root, 'dist') || source === target) throw new Error('Invalid build directory');
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
async function copyTree(from, to) {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) throw new Error(`Unexpected web asset: ${entry.name}`);
    const input = resolve(from, entry.name);
    const output = resolve(to, entry.name);
    if (entry.isDirectory()) {
      await mkdir(output, { recursive: true });
      await copyTree(input, output);
    } else {
      if (!allowed.has(extname(entry.name))) throw new Error(`Unsupported web asset: ${entry.name}`);
      await cp(input, output);
    }
  }
}
for (const page of ['index.html', 'browser.html', 'testnet.html']) await readFile(resolve(source, page));
await copyTree(source, target);
await mkdir(resolve(target, 'images'), { recursive: true });
await cp(resolve(root, 'docs/images/wallet-explainer.svg'), resolve(target, 'images/wallet-explainer.svg'));
await writeFile(resolve(target, '.nojekyll'), '');
console.log('Static app built in dist/. No wallet state, keys or server files are published.');
