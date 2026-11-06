import { TOOLS, publicError } from '../../packages/protocol/index.mjs';

export const MCP_VERSION = '2025-11-25';
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Minimal tools-only MCP session. No remote HTTP listener or anonymous wallet access. */
export function createMcpSession({ gateway, credential }) {
  let state = 'new';
  return async function handle(message) {
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0'
        || typeof message.method !== 'string'
        || ('id' in message && !(typeof message.id === 'string' || (typeof message.id === 'number' && Number.isSafeInteger(message.id))))) {
      return rpcError(null, -32600, 'Invalid request');
    }
    const notification = !Object.hasOwn(message, 'id');
    if (notification) {
      if (message.method === 'notifications/initialized' && state === 'initializing') state = 'ready';
      return null;
    }
    const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'ping') return reply({});
    if (message.method === 'initialize') {
      if (state !== 'new' || !message.params || typeof message.params.protocolVersion !== 'string'
          || !message.params.clientInfo || typeof message.params.clientInfo.name !== 'string'
          || typeof message.params.clientInfo.version !== 'string') return rpcError(message.id, -32602, 'Invalid parameters');
      state = 'initializing';
      return reply({ protocolVersion: MCP_VERSION, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'midnight-agent-wallet', version: '0.1.0' },
        instructions: 'Test-network wallet interface. A request or submitted status is not a finalized payment. Do not request wallet secrets. Payments are disabled until a verified backend is configured.' });
    }
    if (state !== 'ready') return rpcError(message.id, -32000, 'Session is not initialized');
    if (message.method === 'tools/list') {
      if (message.params && Object.keys(message.params).length) return rpcError(message.id, -32602, 'Invalid parameters');
      return reply({ tools: TOOLS });
    }
    if (message.method !== 'tools/call') return rpcError(message.id, -32601, 'Method not found');
    const params = message.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)
        || Object.keys(params).some((key) => !['name', 'arguments', '_meta'].includes(key))
        || !TOOLS.some((tool) => tool.name === params.name)) return rpcError(message.id, -32602, 'Invalid parameters');
    try {
      const data = await gateway.call(params.name, params.arguments ?? {}, credential);
      return reply({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false });
    } catch (error) {
      const data = publicError(error);
      return reply({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: true });
    }
  };
}

/** Newline JSON framing with bounded messages and sequential processing/backpressure. */
export async function serveStdio({ input, output, handle, maxBytes = 16_384 }) {
  let buffer = Buffer.alloc(0);
  const send = async (reply) => {
    if (reply === null) return;
    await new Promise((resolve, reject) => {
      output.write(`${JSON.stringify(reply)}\n`, (error) => error ? reject(error) : resolve());
    });
  };
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 10) continue;
      if (buffer.length + index - start > maxBytes) throw new Error('MCP message exceeds maximum length');
      const line = Buffer.concat([buffer, bytes.subarray(start, index)]);
      buffer = Buffer.alloc(0); start = index + 1;
      let message;
      try { message = JSON.parse(line.toString('utf8')); }
      catch { await send(rpcError(null, -32700, 'Parse error')); continue; }
      await send(await handle(message));
    }
    if (buffer.length + bytes.length - start > maxBytes) throw new Error('MCP message exceeds maximum length');
    buffer = Buffer.concat([buffer, bytes.subarray(start)]);
  }
  if (buffer.length) await send(rpcError(null, -32700, 'Incomplete message'));
}
