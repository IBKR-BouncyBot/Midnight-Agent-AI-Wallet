/** Witness adapters only. Authentication and limits are checked by Compact.
 * Owner and agent secrets belong to distinct runner credential contexts.
 * Never return the private state or transaction preimages through the agent API.
 */
const read = (key) => ({ privateState }) => [privateState, privateState[key]];

export const witnesses = {
  ownerSecret: read('ownerSecret'),
  agentSecret: read('agentSecret'),
  privatePolicy: read('policy'),
  policySalt: read('policySalt'),
  privateState: read('state'),
  stateSalt: read('stateSalt'),
  nextStateSalt: read('nextStateSalt'),
  coinIndex: ({ privateState }) => {
    if (typeof privateState.coinIndex !== 'bigint') {
      throw new Error('Coin qualification required before spending');
    }
    return [privateState, privateState.coinIndex];
  },
  rememberState: ({ privateState }, state, salt) => [
    { ...privateState, state, stateSalt: salt, coinIndex: null }, []
  ],
  rememberPolicy: ({ privateState }, policy, salt) => [
    { ...privateState, policy, policySalt: salt }, []
  ],
};

export function emptySpendingState() {
  return {
    coin: { nonce: new Uint8Array(32), color: new Uint8Array(32), value: 0n },
    hasCoin: false, spent: 0n, sequence: 0n,
  };
}
