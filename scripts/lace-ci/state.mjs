import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from('LACE-CI-STATE\0\x01');
const SCHEMA = 'midnight-agent-lace-ci-state/v1';
const MAX_HEADER = 4096, MAX_PATH = 4096, MAX_ENTRIES = 100_000;
const MAX_FILE = 1024 * 1024 * 1024, MAX_TOTAL = 2 * MAX_FILE, MAX_ARCHIVE = MAX_FILE;
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const exactKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === names.sort().join(',');
function normalizeContext(context) {
  if (!exactKeys(context, ['repository', 'network', 'walletVersion'])
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository)
    || context.network !== 'preview' || !/^\d+\.\d+\.\d+$/.test(context.walletVersion)) fail('CI_STATE_CONTEXT_INVALID');
  return { repository: context.repository, network: context.network, walletVersion: context.walletVersion };
}
function keyBytes(key) {
  if (typeof key === 'string') {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) fail('CI_STATE_KEY_INVALID');
    const decoded = Buffer.from(key, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64') !== key) fail('CI_STATE_KEY_INVALID');
    return decoded;
  }
  if (!(key instanceof Uint8Array) || key.length !== 32) fail('CI_STATE_KEY_INVALID');
  return Buffer.from(key);
}
function safePath(name) {
  if (typeof name !== 'string' || !name || Buffer.byteLength(name) > MAX_PATH || isAbsolute(name)
    || /[\\:\x00-\x1f]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) fail('CI_STATE_PATH_INVALID');
  return name;
}
function inside(root, name) {
  const path = resolve(root, ...safePath(name).split('/'));
  if (!path.startsWith(root + sep)) fail('CI_STATE_PATH_INVALID');
  return path;
}
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function requireStateDirectory(root) {
  const directory = await lstat(root);
  const profile = await lstat(join(root, 'profile'));
  const metadata = await lstat(join(root, 'session-private.json'));
  if (!directory.isDirectory() || directory.isSymbolicLink() || !profile.isDirectory() || profile.isSymbolicLink()
    || !metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) fail('CI_STATE_LAYOUT_INVALID');
  for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    if (await exists(join(root, 'profile', lock))) fail('CI_STATE_PROFILE_NOT_CLOSED');
  }
}
function entryHeader(kind, name, size) {
  const path = Buffer.from(name); const header = Buffer.alloc(13);
  header[0] = kind; header.writeUInt32BE(path.length, 1); header.writeBigUInt64BE(BigInt(size), 5);
  return Buffer.concat([header, path]);
}
async function* archiveEntries(root, metrics) {
  async function* walk(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const relative = safePath(prefix ? `${prefix}/${name}` : name), path = inside(root, relative);
      const info = await lstat(path);
      if (++metrics.entries > MAX_ENTRIES || info.isSymbolicLink()) fail('CI_STATE_ENTRY_INVALID');
      if (info.isDirectory()) {
        yield entryHeader(1, relative, 0); yield* walk(path, relative);
      } else if (info.isFile()) {
        if (info.size > MAX_FILE || (metrics.plaintextBytes += info.size) > MAX_TOTAL) fail('CI_STATE_SIZE_LIMIT');
        yield entryHeader(2, relative, info.size);
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.size !== info.size || before.ino !== info.ino) fail('CI_STATE_SOURCE_CHANGED');
          let count = 0;
          while (true) {
            const chunk = Buffer.alloc(64 * 1024), { bytesRead } = await handle.read(chunk, 0, chunk.length, count);
            if (!bytesRead) break;
            count += bytesRead; if (count > info.size) fail('CI_STATE_SOURCE_CHANGED'); yield chunk.subarray(0, bytesRead);
          }
          const after = await handle.stat();
          if (count !== info.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('CI_STATE_SOURCE_CHANGED');
        } finally { await handle.close(); }
      } else fail('CI_STATE_ENTRY_INVALID');
    }
  }
  yield* walk(root); yield entryHeader(0, '', 0);
}

/** Encrypt an entire CLOSED, disposable CI browser state. No raw profile is an
 * evidence artifact. This is lifecycle persistence, not a crash-safe remote
 * checkpoint or proof that a pending transaction did not reach the network. */
export async function sealDirectory({ sourceDir, archiveFile, key, context }) {
  const root = resolve(sourceDir), output = resolve(archiveFile), normalized = normalizeContext(context), secret = keyBytes(key);
  let created = false;
  try {
    if (output === root || output.startsWith(root + sep)) fail('CI_STATE_ARCHIVE_INSIDE_SOURCE');
    await requireStateDirectory(root);
    const header = Buffer.from(JSON.stringify({ schema: SCHEMA, context: normalized, cipher: 'aes-256-gcm', compression: 'gzip', nonce: randomBytes(12).toString('base64') }));
    const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
    const prefix = Buffer.concat([MAGIC, length, header]);
    const handle = await open(output, 'wx', 0o600); created = true;
    const metrics = { entries: 0, plaintextBytes: 0 };
    try {
      await handle.writeFile(prefix);
      const nonce = JSON.parse(header.toString()).nonce;
      const cipher = createCipheriv('aes-256-gcm', secret, Buffer.from(nonce, 'base64')); cipher.setAAD(prefix);
      await pipeline(Readable.from(archiveEntries(root, metrics)), createGzip(), cipher, async source => {
        for await (const chunk of source) await handle.writeFile(chunk);
      });
      await handle.writeFile(cipher.getAuthTag());
      await handle.sync();
    } finally { await handle.close(); }
    const size = (await stat(output)).size;
    if (size > MAX_ARCHIVE) fail('CI_STATE_SIZE_LIMIT');
    return { schema: SCHEMA, context: normalized, ...metrics, archiveBytes: size };
  } catch (error) {
    if (created) await rm(output, { force: true });
    throw error;
  } finally { secret.fill(0); }
}

class ArchiveReader {
  constructor(stream) { this.stream = stream; this.iterator = stream[Symbol.asyncIterator](); this.chunk = Buffer.alloc(0); this.offset = 0; }
  async read(size, optional = false) {
    const result = Buffer.alloc(size); let count = 0;
    while (count < size) {
      if (this.offset === this.chunk.length) {
        const next = await this.iterator.next();
        if (next.done) { if (optional && count === 0) return null; fail('CI_STATE_ARCHIVE_INVALID'); }
        this.chunk = next.value; this.offset = 0;
      }
      const length = Math.min(size - count, this.chunk.length - this.offset);
      this.chunk.copy(result, count, this.offset, this.offset + length); count += length; this.offset += length;
    }
    return result;
  }
}
async function readAt(handle, size, position) {
  const data = Buffer.alloc(size); let count = 0;
  while (count < size) { const result = await handle.read(data, count, size - count, position + count); if (!result.bytesRead) fail('CI_STATE_ARCHIVE_INVALID'); count += result.bytesRead; }
  return data;
}
async function unpack(payload, root) {
  const compressed = createReadStream(payload), stream = compressed.pipe(createGunzip());
  compressed.on('error', error => stream.destroy(error));
  const reader = new ArchiveReader(stream), paths = new Set(), directories = new Set(['']);
  const metrics = { entries: 0, plaintextBytes: 0 };
  try {
    while (true) {
      const header = await reader.read(13), kind = header[0], length = header.readUInt32BE(1), rawSize = header.readBigUInt64BE(5);
      if (kind === 0) { if (length || rawSize || await reader.read(1, true)) fail('CI_STATE_ARCHIVE_INVALID'); break; }
      if (![1, 2].includes(kind) || length < 1 || length > MAX_PATH || rawSize > BigInt(MAX_FILE)
        || ++metrics.entries > MAX_ENTRIES) fail('CI_STATE_ARCHIVE_INVALID');
      const encoded = await reader.read(length), name = safePath(new TextDecoder('utf-8', { fatal: true }).decode(encoded));
      const unique = process.platform === 'win32' ? name.toLowerCase() : name;
      const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
      if (paths.has(unique) || !directories.has(parent)) fail('CI_STATE_PATH_INVALID');
      paths.add(unique); const target = inside(root, name), size = Number(rawSize);
      if (kind === 1) {
        if (size) fail('CI_STATE_ARCHIVE_INVALID'); await mkdir(target, { mode: 0o700 }); directories.add(name);
      } else {
        if ((metrics.plaintextBytes += size) > MAX_TOTAL) fail('CI_STATE_SIZE_LIMIT');
        const file = await open(target, 'wx', 0o600);
        try { for (let remaining = size; remaining > 0;) { const chunk = await reader.read(Math.min(remaining, 64 * 1024)); await file.writeFile(chunk); remaining -= chunk.length; } }
        finally { await file.close(); }
      }
    }
    await requireStateDirectory(root); return metrics;
  } finally { stream.destroy(); compressed.destroy(); }
}

/** Authenticate before extraction, reject traversal/symlinks/duplicates, and
 * refuse any existing destination. The caller must still gate pending progress
 * and reconcile chain state; an authentic older archive is not fresh evidence. */
export async function restoreDirectory({ archiveFile, destinationDir, key, context }) {
  const destination = resolve(destinationDir), normalized = normalizeContext(context), secret = keyBytes(key);
  let staging, created = false;
  try {
    if (await exists(destination)) fail('CI_STATE_DESTINATION_EXISTS');
    const input = await open(resolve(archiveFile), 'r'); let prefix, header, size;
    try {
      size = (await input.stat()).size;
      if (size < MAGIC.length + 4 + 16 || size > MAX_ARCHIVE) fail('CI_STATE_ARCHIVE_INVALID');
      const start = await readAt(input, MAGIC.length + 4, 0);
      if (!start.subarray(0, MAGIC.length).equals(MAGIC)) fail('CI_STATE_ARCHIVE_INVALID');
      const length = start.readUInt32BE(MAGIC.length);
      if (!length || length > MAX_HEADER || start.length + length + 16 >= size) fail('CI_STATE_ARCHIVE_INVALID');
      const bytes = await readAt(input, length, start.length); prefix = Buffer.concat([start, bytes]);
      try { header = JSON.parse(bytes.toString('utf8')); } catch { fail('CI_STATE_ARCHIVE_INVALID'); }
      if (!exactKeys(header, ['schema', 'context', 'cipher', 'compression', 'nonce']) || header.schema !== SCHEMA
        || header.cipher !== 'aes-256-gcm' || header.compression !== 'gzip' || !/^[A-Za-z0-9+/]{16}$/.test(header.nonce)) fail('CI_STATE_ARCHIVE_INVALID');
      if (JSON.stringify(normalizeContext(header.context)) !== JSON.stringify(normalized)) fail('CI_STATE_CONTEXT_MISMATCH');
      const tag = await readAt(input, 16, size - 16);
      staging = await mkdtemp(join(dirname(destination), '.lace-ci-restore-'));
      const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(header.nonce, 'base64'));
      decipher.setAAD(prefix); decipher.setAuthTag(tag);
      try {
        const ciphertext = async function* () {
          for (let position = prefix.length; position < size - 16;) {
            const chunk = await readAt(input, Math.min(64 * 1024, size - 16 - position), position); position += chunk.length; yield chunk;
          }
        };
        await pipeline(Readable.from(ciphertext()), decipher,
          createWriteStream(join(staging, 'payload.gz'), { flags: 'wx', mode: 0o600 }));
      } catch { fail('CI_STATE_AUTHENTICATION_FAILED'); }
    } finally { await input.close(); }
    const tree = join(staging, 'state'); await mkdir(tree, { mode: 0o700 });
    const metrics = await unpack(join(staging, 'payload.gz'), tree);
    // Exclusive creation is deliberate: rename alone can replace an existing
    // empty directory on Linux. An interrupted move leaves a blocked destination.
    await mkdir(destination, { mode: 0o700 }); created = true;
    for (const name of await readdir(tree)) await rename(join(tree, name), join(destination, name));
    return { schema: SCHEMA, context: normalized, ...metrics, archiveBytes: size };
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally { secret.fill(0); if (staging) await rm(staging, { recursive: true, force: true }); }
}

async function main() {
  if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true') fail('CI_STATE_ISOLATED_RUNNER_REQUIRED');
  const [mode, ...args] = process.argv.slice(2), options = {};
  if (!['seal', 'restore'].includes(mode) || args.length !== 6) fail('CI_STATE_ARGUMENTS_INVALID');
  for (let i = 0; i < args.length; i += 2) {
    if (!['--state-dir', '--archive', '--wallet-version'].includes(args[i]) || options[args[i]] || !args[i + 1]) fail('CI_STATE_ARGUMENTS_INVALID');
    options[args[i]] = args[i + 1];
  }
  const context = { repository: process.env.GITHUB_REPOSITORY, network: 'preview', walletVersion: options['--wallet-version'] };
  const common = { key: process.env.LACE_CI_STATE_KEY, context, archiveFile: options['--archive'] };
  const result = mode === 'seal' ? await sealDirectory({ ...common, sourceDir: options['--state-dir'] })
    : await restoreDirectory({ ...common, destinationDir: options['--state-dir'] });
  process.stdout.write(JSON.stringify({ operation: mode, ...result }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write((/^CI_STATE_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'CI_STATE_OPERATION_FAILED') + '\n'); process.exitCode = 1; });
}
