import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { serialize, deserialize } from 'node:v8';

const AAD = Buffer.from('midnight-agent-wallet:preview-demo:v1');
const MAX_SIZE = 32 * 1024 * 1024;

async function dpapi(bytes, decrypt = false) {
  const operation = decrypt ? 'Unprotect' : 'Protect';
  // Data is piped on stdin, never interpolated into a command line or log.
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${operation}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  return new Promise((resolveResult, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', length = 0;
    child.stdout.on('data', (chunk) => { length += chunk.length; if (length > 16_384) child.kill(); else output += chunk.toString(); });
    child.stderr.resume();
    child.on('error', () => reject(new Error('Windows user-key protection is unavailable')));
    child.on('close', (code) => code === 0 ? resolveResult(Buffer.from(output, 'base64')) : reject(new Error('Windows user-key protection failed')));
    child.stdin.end(Buffer.from(bytes).toString('base64'));
  });
}

export async function loadDemoKey(directory, { password = process.env.MIDNIGHT_DEMO_PASSWORD, createIfMissing = true } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, 'key-protection.json');
  let metadata;
  try { metadata = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Demo key metadata is unreadable'); }
  if (!metadata) {
    if (!createIfMissing) throw new Error('Demo key metadata is missing; restore its backup');
    if (password) {
      if (password.length < 16) throw new Error('MIDNIGHT_DEMO_PASSWORD must contain at least 16 characters');
      metadata = { version: 1, kind: 'scrypt', salt: randomBytes(32).toString('base64') };
    } else if (process.platform === 'win32' || process.env.WSL_DISTRO_NAME) {
      const random = randomBytes(32);
      try { metadata = { version: 1, kind: 'windows-current-user-dpapi', wrapped: (await dpapi(random)).toString('base64') }; }
      finally { random.fill(0); }
    } else throw new Error('Set MIDNIGHT_DEMO_PASSWORD before starting this non-Windows demo');
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(metadata)); await handle.sync(); } finally { await handle.close(); }
  }
  if (metadata.version !== 1) throw new Error('Unsupported demo key format');
  if (metadata.kind === 'windows-current-user-dpapi') return { key: await dpapi(Buffer.from(metadata.wrapped, 'base64'), true), protection: metadata.kind };
  if (metadata.kind === 'scrypt' && password && password.length >= 16) return {
    key: scryptSync(password, Buffer.from(metadata.salt, 'base64'), 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }), protection: 'scrypt',
  };
  throw new Error('The demo unlock password is required');
}

/** One cooperating writer; authenticated encrypted binary snapshots. */
export class DemoVault {
  #file; #key; #state; #lock; #queue = Promise.resolve(); #closed = false;
  static async open(file, key, { createIfMissing = true } = {}) {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error('Invalid demo storage key');
    const vault = new DemoVault(); vault.#file = resolve(file); vault.#key = Buffer.from(key);
    await mkdir(dirname(vault.#file), { recursive: true, mode: 0o700 });
    vault.#lock = await open(`${vault.#file}.lock`, 'wx', 0o600);
    try {
      await vault.#lock.writeFile(JSON.stringify({ pid: process.pid })); await vault.#lock.sync();
      try {
        const encrypted = await readFile(vault.#file);
        if (encrypted.length < 30 || encrypted.length > MAX_SIZE || encrypted[0] !== 1) throw new Error('Invalid encrypted demo state');
        const decipher = createDecipheriv('aes-256-gcm', vault.#key, encrypted.subarray(1, 13));
        decipher.setAAD(AAD); decipher.setAuthTag(encrypted.subarray(13, 29));
        const plain = Buffer.concat([decipher.update(encrypted.subarray(29)), decipher.final()]);
        // V8 may return typed-array views into its input buffer. Detach every
        // restored secret before wiping that decrypted buffer.
        try { vault.#state = structuredClone(deserialize(plain)); } finally { plain.fill(0); }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!createIfMissing) throw new Error('Encrypted demo identity is missing; restore its backup');
        vault.#state = { version: 1, network: 'preview', ownerSeed: randomBytes(32), merchantSeed: randomBytes(32),
          privateStorePassword: `Private-Demo-${randomBytes(32).toString('base64url')}!`,
          runnerKey: randomBytes(32), journalKey: randomBytes(32), ownerSecret: randomBytes(32), agentSecret: randomBytes(32),
          vaultId: randomBytes(32), setup: {}, transactions: [], uncertain: null };
        await vault.#save(vault.#state);
      }
      if (vault.#state.version !== 1 || vault.#state.network !== 'preview') throw new Error('Wrong demo state network');
      return vault;
    } catch (error) { await vault.close(); throw error; }
  }
  snapshot() { if (this.#closed) throw new Error('Demo vault is closed'); return structuredClone(this.#state); }
  async #save(state) {
    const plain = serialize(state);
    if (plain.length > MAX_SIZE - 29) throw new Error('Demo state too large');
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.#key, nonce); cipher.setAAD(AAD);
    let encrypted;
    try {
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      encrypted = Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
    } finally { plain.fill(0); }
    const temporary = `${this.#file}.${randomBytes(8).toString('hex')}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(encrypted); await handle.sync(); } finally { await handle.close(); }
    try {
      await rename(temporary, this.#file);
      if (process.platform !== 'win32') { const dir = await open(dirname(this.#file), 'r'); try { await dir.sync(); } finally { await dir.close(); } }
    } finally { await unlink(temporary).catch(() => {}); }
  }
  update(change) {
    if (this.#closed) return Promise.reject(new Error('Demo vault is closed'));
    const result = this.#queue.then(async () => {
      const draft = structuredClone(this.#state); await change(draft); await this.#save(draft); this.#state = draft;
    });
    this.#queue = result.catch(() => {}); return result;
  }
  async close() {
    if (this.#closed) return; this.#closed = true; await this.#queue; this.#key?.fill(0);
    if (this.#lock) { await this.#lock.close(); await unlink(`${this.#file}.lock`); this.#lock = null; }
  }
}
