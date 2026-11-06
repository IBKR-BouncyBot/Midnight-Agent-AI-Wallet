import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../web');
const entries = await readdir(root);
let checked = 0;
for (const name of entries) {
  const file = resolve(root, name);
  if (name.endsWith('.mjs') || name.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  if (!name.endsWith('.html')) continue;
  const html = await readFile(file, 'utf8');
  assert.match(html, /name="viewport"/, `${name}: responsive viewport`);
  assert.match(html, /Content-Security-Policy/, `${name}: content security policy`);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${name}: use external event listeners`);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size, `${name}: duplicate element IDs`);
  for (const [, attribute, raw] of html.matchAll(/\b(href|src)="([^"]+)"/g)) {
    if (/^(?:https?:|data:|mailto:)/.test(raw)) continue;
    const [pathname, fragment] = raw.split('#');
    if (!pathname && !fragment) continue;
    let target = pathname ? resolve(dirname(file), decodeURIComponent(pathname)) : file;
    if (pathname.endsWith('/')) target = resolve(target, 'index.html');
    assert.ok(target.startsWith(root + sep), `${name}: asset escapes web root`);
    assert.ok((await stat(target)).isFile(), `${name}: missing ${attribute} ${raw}`);
    if (fragment && target.endsWith('.html')) {
      const targetHtml = target === file ? html : await readFile(target, 'utf8');
      assert.ok(targetHtml.includes(`id="${fragment}"`), `${name}: missing anchor ${raw}`);
    }
    checked++;
  }
}
console.log(`Frontend syntax, CSP presence, IDs and ${checked} local links checked.`);
