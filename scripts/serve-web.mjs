import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const directory = resolve(import.meta.dirname, process.argv.includes('--dist') ? '../dist' : '../web');
const port = Number(process.env.WALLET_WEB_PORT ?? 17640);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid WALLET_WEB_PORT');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.wasm':'application/wasm', '.json':'application/json', '.bin':'application/octet-stream', '.prover':'application/octet-stream', '.verifier':'application/octet-stream', '.bzkir':'application/octet-stream' };
const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (request.headers.host !== `127.0.0.1:${port}` && request.headers.host !== `localhost:${port}`) {
    response.writeHead(403).end('Unrecognized host'); return;
  }
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(request.url, `http://127.0.0.1:${port}`).pathname);
    const file = resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`);
    const contentType = mime[extname(file)] ?? (/[/\\]bls_midnight_2p\d+$/.test(file) ? 'application/octet-stream' : null);
    if (!file.startsWith(directory + sep) || !contentType) { response.writeHead(404).end('Not found'); return; }
    const data = await readFile(file);
    response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch { response.writeHead(404).end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Wallet app: http://127.0.0.1:${port}/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
