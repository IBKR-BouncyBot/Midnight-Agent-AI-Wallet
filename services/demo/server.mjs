import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const DEMO_PORT = 17641;
const ORIGINS = new Set(['http://127.0.0.1:17640', 'http://localhost:17640', 'https://ibkr-bouncybot.github.io']);
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const fail = (code) => Object.assign(new Error('Request rejected'), { httpCode: code });

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw fail(415);
  if (Number(request.headers['content-length'] ?? 0) > 8192) throw fail(413);
  let length = 0; const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 8192) throw fail(413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400);
  return value;
}
function keys(value, expected) {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw fail(400);
}
function authorized(header, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(typeof header === 'string' ? header : '');
  return given.length === expected.length && timingSafeEqual(expected, given);
}

/** Owner-only loopback demo bridge; this token must never be given to an AI client. */
export function createDemoHttpServer(service, { token = randomBytes(32).toString('base64url'), port = DEMO_PORT } = {}) {
  if (!TOKEN.test(token)) throw new Error('Invalid bridge token');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid bridge port');
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const reply = (status, value) => response.writeHead(status).end(JSON.stringify(value));
    try {
      const listening = server.address();
      const actualPort = typeof listening === 'object' && listening ? listening.port : port;
      if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(request.headers.host)) throw fail(403);
      const origin = request.headers.origin;
      if (origin && !ORIGINS.has(origin)) throw fail(403);
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        if (!origin || !['GET', 'POST'].includes(request.headers['access-control-request-method'])) throw fail(403);
        const requested = (request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
        if (requested.some(value => !['authorization', 'content-type'].includes(value))) throw fail(403);
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        response.setHeader('Access-Control-Allow-Private-Network', 'true');
        response.writeHead(204).end(); return;
      }
      if (!['GET', 'POST'].includes(request.method)) throw fail(405);
      const url = new URL(request.url, `http://127.0.0.1:${actualPort}`);
      if (url.search || url.hash) throw fail(400);
      if (request.method === 'GET' && url.pathname === '/health') {
        reply(200, { service: 'midnight-agent-wallet-demo', network: 'preview' }); return;
      }
      if (!authorized(request.headers.authorization, token)) throw fail(401);
      if (request.method === 'GET') {
        if (url.pathname === '/api/status') { reply(200, service.status()); return; }
        const payment = /^\/api\/payments\/([^/]+)$/.exec(url.pathname);
        if (payment && ID.test(payment[1])) { reply(200, await service.getPayment(payment[1])); return; }
        throw fail(404);
      }
      const body = await readBody(request);
      let action; let task;
      switch (url.pathname) {
        case '/api/setup': keys(body, []); action = 'setup'; task = () => service.setup(); break;
        case '/api/register-dust': keys(body, []); action = 'register-dust'; task = () => service.registerDust(); break;
        case '/api/bootstrap': keys(body, []); action = 'bootstrap'; task = () => service.bootstrap(); break;
        case '/api/reconcile': keys(body, []); action = 'reconcile'; task = () => service.reconcile(); break;
        case '/api/payments':
          keys(body, ['amount', 'idempotencyKey']);
          if (typeof body.amount !== 'string' || !/^[1-9][0-9]{0,19}$/.test(body.amount) || BigInt(body.amount) > (1n << 64n) - 1n
              || typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(body.idempotencyKey)) throw fail(400);
          action = 'payment'; task = () => service.requestPayment(body); break;
        case '/api/owner/pause':
          keys(body, ['paused']); if (typeof body.paused !== 'boolean') throw fail(400);
          action = body.paused ? 'owner-pause' : 'owner-resume'; task = () => service.owner('pause', body); break;
        case '/api/owner/revoke': keys(body, []); action = 'owner-revoke'; task = () => service.owner('revoke', body); break;
        case '/api/owner/withdraw': keys(body, []); action = 'owner-withdraw'; task = () => service.owner('withdraw', body); break;
        default: throw fail(404);
      }
      reply(202, service.startJob(action, task));
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const status = error.httpCode ?? (error.code === 'PAYMENT_UNAVAILABLE' ? 409 : 400);
      reply(status, { error: status === 401 || status === 403 ? 'PAIRING_REJECTED' : 'REQUEST_REJECTED' });
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  return { server, token, listen: () => new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address()); });
  }) };
}

async function main() {
  const { DemoService } = await import('./service.mjs');
  const service = await DemoService.create({ proofServer: process.env.MIDNIGHT_DEMO_PROOF_SERVER });
  const bridge = createDemoHttpServer(service);
  try { await bridge.listen(); } catch (error) { await service.close(); throw error; }
  console.log(`Preview runner: http://127.0.0.1:${DEMO_PORT}`);
  console.log(`Open privately: http://127.0.0.1:17640/local.html#bridgeToken=${bridge.token}`);
  console.log('Keep this terminal open. Run npm run dev in another terminal if the page is unavailable. Type stop and press Enter to close safely.');
  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    bridge.server.close(); await service.close(); process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', text => { if (text.trim() === 'stop') void shutdown(); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Preview runner could not start. Check compiled contracts, private storage and port 17641.'); process.exitCode = 1; });
}
