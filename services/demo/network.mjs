import { ZswapOutput, ZswapInput } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { decodeShieldedCoinInfo, decodeQualifiedShieldedCoinInfo } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';

export async function graph(config, query, variables = {}) {
  const response = await fetch(config.indexer, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (!response.ok) throw new Error('Preview indexer unavailable');
  const result = await response.json();
  if (result.errors?.length || !result.data) throw new Error('Preview indexer query failed');
  return result.data;
}
export async function chainTime(config) {
  const result = await graph(config, '{ block { timestamp } }');
  const timestamp = new Date(result.block?.timestamp).getTime();
  if (!Number.isFinite(timestamp)) throw new Error('Missing chain clock');
  return Math.floor(timestamp / 1000);
}
export async function qualifyCoin(config, tx, coin, contractAddress) {
  const offers = [];
  if (tx.tx.guaranteedOffer?.outputs.length) offers.push([0, tx.tx.guaranteedOffer]);
  for (const [segment, offer] of tx.tx.fallibleOffer ?? []) if (offer.outputs.length) offers.push([segment, offer]);
  if (offers.length !== 1) throw new Error('Unsupported mixed output segment qualification');
  const [segment, offer] = offers[0];
  const expected = ZswapOutput.newContractOwned(decodeShieldedCoinInfo(coin), segment, contractAddress).commitment;
  const matches = offer.outputs.map((output, index) => output.commitment === expected ? index : -1).filter((index) => index >= 0);
  if (matches.length !== 1) throw new Error('Missing exact contract change output');
  const data = await graph(config, 'query ($id: HexEncoded!) { transactions(offset: { identifier: $id }) { ... on RegularTransaction { zswapStartIndex } } }', { id: tx.txId });
  if (data.transactions?.length !== 1) throw new Error('Missing indexed transaction');
  const start = data.transactions[0].zswapStartIndex;
  if (!(typeof start === 'string' && /^\d+$/.test(start)) && !Number.isSafeInteger(start)) throw new Error('Invalid commitment index');
  return BigInt(start) + BigInt(matches[0]);
}
export function verifyCoinMembership(chain, coin, index, address) {
  if (typeof index !== 'bigint') return false;
  ZswapInput.newContractOwned(decodeQualifiedShieldedCoinInfo({ ...coin, mt_index: index }), 0, address, chain.postBlockUpdate(new Date()));
  return true;
}
export async function waitBalance(wallet, color, expected, ms = 120_000) {
  const end = Date.now() + ms;
  do {
    const state = wallet.current();
    if (state && state.shielded.state.progress.isStrictlyComplete() && (state.shielded.balances[color] ?? 0n) === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (Date.now() < end);
  throw new Error('Independent recipient balance is not yet verified');
}
export async function bounded(promise, ms = 180_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Network outcome unresolved')), ms); })]); }
  finally { clearTimeout(timer); }
}
