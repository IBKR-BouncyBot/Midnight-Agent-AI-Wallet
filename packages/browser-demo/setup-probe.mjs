import { BrowserDemoService, createInitialState } from './service.mjs';
import { createHash } from './crypto.mjs';
import { ZswapSecretKeys } from '@midnight-ntwrk/ledger-v8';

/** Actual production setup against public Preview, using a synthetic read-only
 * Lace adapter and disposable in-memory state. Never connects a real wallet. */
export async function runBrowserSetupProbe({ enabled = false } = {}) {
  if (enabled !== true || !['127.0.0.1','localhost','[::1]'].includes(location.hostname)) throw new Error('LOCAL_SETUP_PROBE_ONLY');
  const accountId = 'synthetic-browser-setup-probe-v1';
  const keys = ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(24));
  const publicKeys = { coinPublicKeyHex: keys.coinPublicKey, encryptionPublicKeyHex: keys.encryptionPublicKey };
  keys.clear();
  let state = createInitialState({ accountId }), closed = false, networkRequests = 0, forbiddenActions = 0, webSocketConnections = 0;
  state.merchantSnapshot = 'opaque-legacy-snapshot-must-remain-unchanged';
  const before = structuredClone(state);
  const store = { context: { network:'preview', identityId:createHash('sha256').update('preview:'+accountId).digest('hex') },
    snapshot:()=>structuredClone(state), async update(fn) { const next=structuredClone(state);await fn(next);state=next; },
    async close(){closed=true;} };
  const forbidden = () => { forbiddenActions++; throw new Error('PROBE_TRANSACTION_FORBIDDEN'); };
  const connection = { context:{accountId,unshieldedAddress:'synthetic-not-a-funding-address',...publicKeys},
    async assertSession(){}, async assertInProcess(){}, async getShieldedBalance(){return 0n;},
    async getPublicStatus(){return {connected:true,canTransact:true,dustAtomic:'1'};},
    walletProvider:{getCoinPublicKey:()=>publicKeys.coinPublicKeyHex,getEncryptionPublicKey:()=>publicKeys.encryptionPublicKeyHex,balanceTx:forbidden},
    midnightProvider:{submitTx:forbidden},close(){} };
  const originalFetch=globalThis.fetch;
  const originalWebSocket=globalThis.WebSocket;
  globalThis.WebSocket=new Proxy(originalWebSocket,{construct(){webSocketConnections++;throw new Error('SETUP_HISTORY_STREAM_FORBIDDEN');}});
  globalThis.fetch=async(input,options)=>{
    const url=new URL(typeof input==='string'?input:input.url);
    if(url.href!=='https://rpc.preview.midnight.network/')throw new Error('UNEXPECTED_SETUP_NETWORK_REQUEST');
    networkRequests++; return originalFetch(input,options);
  };
  let service;
  const started=performance.now();
  try {
    service=await BrowserDemoService.create({connection,store,prover:{proveTx:forbidden,close(){}},assetBase:new URL('./browser-contracts/',location.href).href});
    await service.setup();
    const elapsedMs=Math.round(performance.now()-started), status=await service.status();
    const preserved=['ownerSecret','agentSecret','merchantSeed','vaultId'].every(name=>before[name].every((value,index)=>value===state[name][index]))
      &&state.merchantSnapshot===before.merchantSnapshot;
    if(!status.merchant.ready||status.merchant.verificationMode!=='finalized-output-decryption'||!status.capabilities.canBootstrap||!preserved||forbiddenActions)throw new Error('SETUP_PROBE_FAILED');
    return {schema:'midnight-browser-recipient-setup/v1',elapsedMs,recipientReady:true,
      verificationMode:status.merchant.verificationMode,legacyIdentityAndSnapshotPreserved:preserved,
      publicRpcRequests:networkRequests,webSocketConnections,transactionActions:forbiddenActions,historyReplayRequired:false,
      syntheticLaceAdapter:true,realLaceConnectionTested:false,network:'preview',networkSubmission:'not-attempted'};
  } finally {globalThis.fetch=originalFetch;globalThis.WebSocket=originalWebSocket;await service?.close();if(!closed)await store.close();}
}
