// Servidor HTTP local: recebe eventos dos hooks e transmite o estado ao navegador via SSE.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore } from './store.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY = 512 * 1024;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/office.js': ['office.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

export function createOfficeServer({ store = new SessionStore(), sweepMs = 1000 } = {}) {
  const clients = new Set();

  const broadcast = () => {
    const data = `data: ${JSON.stringify(store.snapshot())}\n\n`;
    for (const res of clients) res.write(data);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/api/event') {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          res.writeHead(400).end('invalid json');
          return;
        }
        if (store.apply(payload)) broadcast();
        res.writeHead(204).end();
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(store.snapshot()));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(store.snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    const entry = req.method === 'GET' && STATIC[url.pathname];
    if (entry) {
      try {
        const body = await readFile(path.join(PUBLIC_DIR, entry[0]));
        res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-cache' });
        res.end(body);
      } catch {
        res.writeHead(500).end();
      }
      return;
    }

    res.writeHead(404).end('not found');
  });

  const sweeper = setInterval(() => {
    if (store.sweep()) broadcast();
  }, sweepMs);
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 15000);
  sweeper.unref();
  heartbeat.unref();

  server.on('close', () => {
    clearInterval(sweeper);
    clearInterval(heartbeat);
    for (const res of clients) res.end();
  });

  return { server, store };
}
