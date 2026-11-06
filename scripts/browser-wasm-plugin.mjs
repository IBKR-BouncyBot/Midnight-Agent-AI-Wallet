import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire, builtinModules } from 'node:module';

export function browserWasmPlugin(root, assets) {
  const require = createRequire(resolve(root, 'package.json'));
  const browserPackages = { buffer: require.resolve('buffer/'), events: require.resolve('events/'), assert: require.resolve('assert/'),
    util: require.resolve('util/'), 'node:assert/strict': resolve(root, 'scripts/browser-assert.mjs') };
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  return { name: 'browser-native-wasm', setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (args.path === 'node:crypto' || args.path === 'node:util') {
        if (args.importer.includes('node_modules')) return { errors: [{ text: `Unexpected Node dependency: ${args.path}` }] };
        return { path: resolve(root, 'packages/browser-demo/crypto.mjs') };
      }
      if (browserPackages[args.path]) return { path: browserPackages[args.path] };
      if (builtins.has(args.path) || args.path.startsWith('node:')) return { errors: [{ text: `Node dependency in browser: ${args.path}` }] };
    });
    build.onResolve({ filter: /\.wasm$/ }, args => {
      const path = resolve(args.resolveDir, args.path);
      return { path, namespace: 'real-wasm' };
    });
    build.onLoad({ filter: /.*/, namespace: 'real-wasm' }, async args => {
      const bytes = await readFile(args.path), module = await WebAssembly.compile(bytes);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const file = `browser-assets/${basename(args.path, '.wasm')}-${digest.slice(0, 16)}.wasm`;
      assets.set(file, bytes);
      const imports = [...new Set(WebAssembly.Module.imports(module).map(item => item.module))];
      return { loader: 'js', resolveDir: dirname(args.path), contents:
        imports.map((name, i) => `import * as m${i} from ${JSON.stringify(name)};`).join('\n') +
        `\nconst r = await fetch(new URL(${JSON.stringify('./' + file)}, import.meta.url), {credentials:'omit',redirect:'error'});\nif(!r.ok)throw new Error('WASM_DOWNLOAD_FAILED');\nconst {instance} = await WebAssembly.instantiate(await r.arrayBuffer(), {${imports.map((name, i) => `${JSON.stringify(name)}:m${i}`).join(',')}});\n` +
        WebAssembly.Module.exports(module).map(({ name }, i) => `const e${i}=instance.exports[${JSON.stringify(name)}];export {e${i} as ${JSON.stringify(name)}};`).join('\n') };
    });
  } };
}
