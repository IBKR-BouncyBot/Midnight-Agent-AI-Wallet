import { randomBytes } from 'node:crypto';
import {
  createCircuitContext, createConstructorContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, pureCircuits } from '../../contracts/managed/private-vault/contract/index.js';
import { emptySpendingState, witnesses } from '../../contracts/witnesses.mjs';

export const bytes = () => new Uint8Array(randomBytes(32));
export const pad = (value) => { const out = new Uint8Array(32); out.set(new TextEncoder().encode(value)); return out; };
export const zero = () => new Uint8Array(32);
export const NOW = 1_800_000_000;

/** Native runtime execution only. This harness does not prove or settle coins. */
export function fixture(overrides = {}) {
  const network = pad('undeployed-local-test');
  const vault = bytes();
  const recipient = bytes();
  const ownerSecret = bytes();
  const agentSecret = bytes();
  const policy = {
    agentKey: pureCircuits.authorityKey(pad('agent-vault:agent:v1'), network, vault, agentSecret),
    asset: bytes(), recipients: [recipient, bytes(), zero(), zero()],
    perPayment: 60n, allowance: 100n, expiresAt: BigInt(NOW + 3600), ...overrides,
  };
  let ps = {
    ownerSecret, agentSecret, policy, policySalt: bytes(),
    state: emptySpendingState(), stateSalt: bytes(), nextStateSalt: bytes(), coinIndex: null,
  };
  const contract = new Contract(witnesses);
  const address = sampleContractAddress();
  let coinPublicKey = Buffer.from(bytes()).toString('hex');
  let state = contract.initialState(createConstructorContext(ps, coinPublicKey), network, vault).currentContractState.data;
  let time = NOW;
  const api = {
    contract, address, network, vault, recipient,
    get ps() { return ps; }, set ps(value) { ps = value; },
    get state() { return state; },
    get time() { return time; }, set time(value) { time = value; },
    get coinPublicKey() { return coinPublicKey; }, set coinPublicKey(value) { coinPublicKey = value; },
    ledger: () => ledger(state),
    call(name, ...args) {
      const context = createCircuitContext(address, coinPublicKey, state, ps, undefined, undefined, time);
      const out = contract.impureCircuits[name](context, ...args);
      state = out.context.currentQueryContext.state;
      ps = out.context.currentPrivateState;
      api.last = out;
      return out;
    },
    request(overrides = {}) {
      return {
        network, vault, deployedContract: new Uint8Array(Buffer.from(address, 'hex')),
        expectedVersion: api.ledger().version, requestId: bytes(), asset: policy.asset,
        recipient, amount: 40n, validFrom: BigInt(time - 10), validUntil: BigInt(time + 60),
        ...overrides,
      };
    },
    // Arbitrary index is deliberate: the Compact runtime does not check Zswap
    // membership. Network tests MUST qualify against finalized transaction data.
    qualifyForRuntimeOnly() { ps = { ...ps, coinIndex: 7n, nextStateSalt: bytes() }; },
    fund(value = 120n) {
      api.call('initializePolicy');
      const coin = { nonce: bytes(), color: policy.asset, value };
      ps.nextStateSalt = bytes();
      api.call('fund', coin);
      api.qualifyForRuntimeOnly();
      return coin;
    },
  };
  return api;
}
