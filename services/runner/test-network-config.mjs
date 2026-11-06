/** Public endpoints verified against Midnight's official network guide on
 * 2026-11-06. Configuration is server-owned, never taken from a payment request.
 * https://docs.midnight.network/guides/networks-and-environments
 */
const NETWORKS = Object.freeze({
  local: Object.freeze({
    network: 'local', networkId: 'undeployed', chainName: null,
    node: 'http://127.0.0.1:19944', nodeWS: 'ws://127.0.0.1:19944',
    indexer: 'http://127.0.0.1:18088/api/v4/graphql',
    indexerWS: 'ws://127.0.0.1:18088/api/v4/graphql/ws',
    faucet: null, explorer: null,
  }),
  preview: Object.freeze({
    network: 'preview', networkId: 'preview', chainName: 'Midnight Preview',
    node: 'https://rpc.preview.midnight.network', nodeWS: 'wss://rpc.preview.midnight.network',
    indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    faucet: 'https://midnight-tmnight-preview.nethermind.dev/',
    explorer: 'https://preview.midnightexplorer.com/',
  }),
});

export function getTestNetworkConfig(network, { proofServer = 'http://127.0.0.1:16300' } = {}) {
  if (!Object.hasOwn(NETWORKS, network)) throw new Error('Choose the local or Preview test network explicitly');
  const prover = new URL(proofServer);
  if (prover.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(prover.hostname)
      || prover.username || prover.password || prover.search || prover.hash || prover.pathname !== '/') {
    throw new Error('The private demo requires a local loopback proof server');
  }
  return Object.freeze({ ...NETWORKS[network], proofServer: prover.origin });
}

/** Read-only public-network identity check; call before starting public wallet
 * operations. No credential, seed, viewing key or private state is transmitted.
 */
export async function verifyPreviewNetwork(config, fetchImpl = globalThis.fetch) {
  const expected = NETWORKS.preview;
  if (config?.networkId !== expected.networkId || config.node !== expected.node
      || config.indexer !== expected.indexer || config.indexerWS !== expected.indexerWS
      || config.nodeWS !== expected.nodeWS) throw new Error('Unexpected Preview endpoint configuration');
  const response = await fetchImpl(expected.node, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_chain', params: [] }),
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Preview identity check failed with HTTP ${response.status}`);
  const result = await response.json();
  if (result.error || result.result !== expected.chainName) throw new Error('RPC did not identify Midnight Preview');
  return Object.freeze({ networkId: expected.networkId, chainName: result.result, verifiedAt: new Date().toISOString() });
}
