import { PaymentGateway } from './gateway.mjs';
import { createMcpSession, serveStdio } from './server.mjs';

// This entry point intentionally supports only inspection. It has no wallet seed,
// backend, journal or payment authority and cannot be switched live by a tool call.
const gateway = new PaymentGateway({
  authenticate: async () => ({
    subject: 'local-inspection', network: 'local', vaultRef: 'local-inspection',
    agentRef: 'inspection', contractAddress: '0'.repeat(64), expiresAt: Number.MAX_SAFE_INTEGER,
  }),
});

try {
  await serveStdio({ input: process.stdin, output: process.stdout,
    handle: createMcpSession({ gateway, credential: undefined }) });
} catch {
  process.stderr.write('MCP inspection process stopped. No wallet backend is configured.\n');
  process.exitCode = 1;
}
