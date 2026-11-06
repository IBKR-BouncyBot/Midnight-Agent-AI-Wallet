# Browser encrypted snapshots

This dependency-free ESM package stores one encrypted root snapshot in IndexedDB.
It is for private vault openings, the confirmed/candidate/pending transaction
journal, and the demo merchant viewer state. The owner wallet stays in Lace;
this package does not request or create an owner wallet seed.

```js
import { BrowserSnapshotStore } from './packages/browser-storage/index.mjs';

// Derive identityId from the actual connected Lace account, never a display name.
const digest = await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(`preview:${laceAccountId}`));
const identityId = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
const options = {
  name: `midnight-agent-preview-${identityId}`,
  context: { network: 'preview', identityId },
  password, // 16–1024 characters; never put it in logs, URLs or model messages.
};

// Separate UI actions. Do not fall back from a failed open to create.
const store = await BrowserSnapshotStore.create({ ...options, initialState });
// On later visits: await BrowserSnapshotStore.open(options).

await store.checkpoint({ ...state, confirmed, candidate, pending: prepared });
await store.checkpoint({ ...state, confirmed, candidate,
  pending: { phase: 'submitting', signedBytes, transactionIds } });
// Only after the second promise resolves may the caller broadcast those bytes.
// Keep an ambiguous outcome pending; reconcile it before another submission.
await store.update(draft => { draft.pending.transactionId = returnedTransactionId; });

const encryptedBackup = await store.exportBackup(); // Uint8Array, suitable for a downloaded file.
await store.close();

// For another origin, or after an explicit restore flow. Fails if the target exists.
const restored = await BrowserSnapshotStore.restore({ ...options, backup: encryptedBackup });
// Reconcile exact private candidates/commitments and pending tx finality before spending.
```

`create` refuses any existing database, including an incomplete/corrupt one.
`open` refuses missing state, wrong passwords, corrupt ciphertext, wrong versions
and a changed public context. `restore` authenticates the entire backup against
the supplied password/context before creating anything, then re-encrypts with a
new salt/nonce. It preserves all opaque application state; the new storage
instance's revision starts at zero. No operation silently replaces an identity.

`snapshot()` returns a detached copy. `checkpoint(nextState)` and `update(fn)`
serialize writes, retain the old in-memory snapshot until commit completes and
reject failed commits. `close()` waits for already accepted writes, drops the
key reference and releases the writer lock. `context` exposes only the public
binding; `revision` counts committed snapshots. There is no spending-ready flag:
successful decryption is not chain reconciliation, and storage never submits.

All cooperating tabs/workers must use the same name. A lifetime exclusive Web
Lock with `ifAvailable` rejects a competing writer immediately. Unsupported Web
Locks, WebCrypto, IndexedDB or strict durability support fail closed. Checkpoints
encrypt before starting the IndexedDB transaction, compare the previous header
and ciphertext inside that transaction, and resolve on `complete`, not a request's
`success` event. The complete root snapshot is one atomic write, so confirmed and
candidate state, signed bytes and IDs cannot be split across stores by this API.
Locks are origin-scoped: close the original app before migrating to another
origin. This package cannot coordinate two simultaneously active origins.
[Web Locks specification](https://www.w3.org/TR/web-locks/),
[IndexedDB transaction specification](https://www.w3.org/TR/IndexedDB/).

The versioned format uses PBKDF2-HMAC-SHA256 (600,000 iterations, fresh 32-byte
salt), a nonexportable AES-256-GCM key, fresh 12-byte nonces and 128-bit tags.
Public format/version/context/KDF metadata and the revision are authenticated as
additional data. Passwords are not stored; JavaScript strings and CryptoKey
objects cannot be reliably wiped, so this makes no memory-erasure claim.
[Web Cryptography specification](https://www.w3.org/TR/WebCryptoAPI/).

The portable codec supports plain objects, arrays, strings, booleans, null,
undefined, safe integer numbers, BigInt and Uint8Array. It rejects accessors,
cycles, sparse arrays, symbols, dates/maps, unsupported prototypes and ambiguous
numbers. Encoded plaintext is limited to **16 MiB**; this is not a claim that an
arbitrary full-history wallet snapshot fits. Keep only necessary merchant viewer
state and measure real snapshot size before increasing the bound. Backup files
contain public metadata and raw authenticated ciphertext, not plaintext seeds
or openings; their maximum size is the snapshot bound plus small format overhead.

Strict IndexedDB durability is a browser hint, not a tested guarantee against
power loss. Origin storage may be cleared/evicted; request persistence in the
application where appropriate and retain a protected encrypted backup plus its
password. Site scripts with same-origin access and an unlocked page can read
private state. Encryption does not defeat compromised frontend code. Restoring
an old, authentic backup also does not prove freshness: the runner must refuse
stale openings and reconcile all pending outcomes against the current chain.
Neither a wallet seed nor public chain data reconstructs missing private openings.

`node --test tests/browser-storage.test.mjs` uses real Node WebCrypto and an
independent Node PBKDF2/AES implementation for interoperability checks. IndexedDB
and Web Locks tests use an explicitly controlled API double to exercise
completion/abort and competing-writer behavior; actual browser-engine persistence,
origin migration UI and process/power-loss recovery need integration verification.
