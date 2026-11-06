import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inspectPublicPayment, validatePublicReferences } from '../scripts/export-preview-evidence.mjs';

// Real public identifier shapes from the previous LOCAL network verification.
// These tests never label them as Preview settlement or fabricate a passing proof.
const id = '0048b39197c561107b1fda7afc34556cafa1243439ba08f9f8f64953fcab45c35a';
const address = '8a0b502b8c0fe2467563b1761a45494e39dd7a3613c6c313e8d2565438ca22b3';

test('public evidence references distinguish tagged transaction IDs from contract addresses', () => {
  assert.doesNotThrow(() => validatePublicReferences(id, address));
  assert.throws(() => validatePublicReferences(id.slice(2), address));
  assert.throws(() => validatePublicReferences(id, id));
  assert.throws(() => validatePublicReferences(id, `../${address}`));
});

test('public evidence refuses absent, partial and unrelated indexer observations before native proof inspection', () => {
  assert.throws(() => inspectPublicPayment(null, id, address));
  assert.throws(() => inspectPublicPayment({ __typename: 'RegularTransaction', transactionResult: { status: 'PARTIAL_SUCCESS' } }, id, address), /succeeded entirely/);
  assert.throws(() => inspectPublicPayment({ __typename: 'RegularTransaction', transactionResult: { status: 'SUCCESS' }, identifiers: [] }, id, address), /another transaction/);
  assert.throws(() => inspectPublicPayment({ __typename: 'RegularTransaction', transactionResult: { status: 'SUCCESS' }, identifiers: [id],
    block: { hash: 'a'.repeat(64), height: 1 }, raw: '' }, id, address), /Invalid public transaction bytes/);
});

test('public evidence CLI rejects nonpublic input without reflecting it or opening wallet storage', async () => {
  const canary = 'DO_NOT_REFLECT_INVALID_INPUT';
  const script = fileURLToPath(new URL('../scripts/export-preview-evidence.mjs', import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [script, canary, address]), (error) => {
    assert.equal(error.code, 1); assert.equal(error.stdout, '');
    assert.match(error.stderr, /did not verify/); assert.ok(!error.stderr.includes(canary)); return true;
  });
});
