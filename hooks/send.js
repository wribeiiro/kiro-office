#!/usr/bin/env node
// Executado pelos hooks do Kiro CLI. Lê o JSON do STDIN e repassa ao kiro-office local.
// Regras: nunca escreve no STDOUT (iria para o contexto do agente), sempre sai com código 0
// e nunca demora mais que ~1,5 s, mesmo com o servidor desligado.
import http from 'node:http';

const port = Number(process.env.KIRO_OFFICE_PORT) || 4317;
const trigger = process.argv[2] || '';
let data = '';
let sent = false;

setTimeout(() => process.exit(0), 1500).unref();
const fallback = setTimeout(send, 800); // se o STDIN nunca fechar, envia o que tiver

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (data.length < 1_000_000) data += chunk;
});
process.stdin.on('end', send);
process.stdin.on('error', send);

function send() {
  if (sent) return;
  sent = true;
  clearTimeout(fallback);

  let payload;
  try {
    payload = data.trim() ? JSON.parse(data) : {};
  } catch {
    payload = {};
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) payload = {};
  payload._event = trigger;
  if (!payload.cwd) payload.cwd = process.cwd();
  if (process.env.USER_PROMPT && payload.prompt == null) payload.prompt = process.env.USER_PROMPT.slice(0, 1000);

  const body = JSON.stringify(payload);
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: '/api/event',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 500,
    },
    (res) => {
      res.resume();
      res.on('end', () => process.exit(0));
    },
  );
  req.on('timeout', () => req.destroy());
  req.on('error', () => process.exit(0));
  req.end(body);
}
