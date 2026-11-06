import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';

// Never resolve Windows' unrelated system32/compact.exe compression tool.
const root = resolve(import.meta.dirname, '..');
const compiler = resolve(root, '.tools/compact/versions/0.31.1/x86_64-unknown-linux-musl/compactc');
const skip = process.argv.includes('--skip-zk');
const selected = process.argv.includes('--contract') ? process.argv[process.argv.indexOf('--contract') + 1] : null;
if (selected !== null && !/^[a-z][a-z0-9-]*$/.test(selected ?? '')) throw new Error('Invalid contract selector');
if (!existsSync(compiler) && process.platform === 'win32') {
  throw new Error('Pinned compiler missing. See docs/local-setup.md.');
}
function linuxPath(path) { return path.replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`).replaceAll('\\', '/'); }
const sources = readdirSync(resolve(root, 'contracts')).filter(name => name.endsWith('.compact') && (!selected || name === `${selected}.compact`)).sort();
if (sources.length === 0) throw new Error('No matching Compact source');
for (const name of sources) {
  const input = resolve(root, 'contracts', name);
  const output = resolve(root, 'contracts/managed', basename(name, '.compact'));
  mkdirSync(output, { recursive: true });
  const args = [...(skip ? ['--skip-zk'] : []), input, output];
  const result = process.platform === 'win32'
    ? spawnSync('wsl.exe', ['-d', 'Ubuntu-24.04', '--cd', linuxPath(dirname(compiler)), '--', './compactc', ...args.map(arg => arg.startsWith('--') ? arg : linuxPath(arg))], { stdio: 'inherit' })
    : spawnSync(process.env.COMPACTC ?? './compactc', args, { stdio: 'inherit', cwd: dirname(compiler) });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

