#!/usr/bin/env node
// Executado pelos hooks do Kiro CLI. Lê o JSON do STDIN e repassa ao kiro-office local.
// Regras: nunca escreve no STDOUT (iria para o contexto do agente), sempre sai com código 0
// e nunca demora mais que ~1,5 s, mesmo com o servidor desligado.
import http from 'node:http';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

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
  // variáveis KIRO_* do ambiente do hook (sem nada que pareça credencial), para achar o nome do agente
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(KIRO|Q)_/i.test(k) && !/(TOKEN|SECRET|KEY|PASS|AUTH|CRED|COOKIE)/i.test(k)) env[k] = String(v).slice(0, 120);
  }
  if (Object.keys(env).length) payload._env = env;
  // nome do agente pela linha de comando do Kiro (kiro-cli chat --agent <nome>)
  const found = agentFromAncestors();
  if (found.agent) payload._agent = found.agent;
  if (found.procs.length) payload._procs = found.procs;

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

/** Sobe a árvore de processos procurando "--agent <nome>" na linha de comando do Kiro. */
function agentFromAncestors() {
  const procs = [];
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    let args;
    let parent;
    try {
      if (process.platform === 'linux') {
        args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      } else if (process.platform === 'darwin') {
        const out = execFileSync('ps', ['-o', 'ppid=,args=', '-p', String(pid)], { encoding: 'utf8', timeout: 300 }).trim();
        const m = out.match(/^(\d+)\s+(.*)$/);
        if (!m) break;
        parent = Number(m[1]);
        args = m[2].split(/\s+/);
      } else {
        break;
      }
    } catch {
      break;
    }
    const line = args.join(' ');
    if (/kiro/i.test(line)) procs.push(line.slice(0, 160));
    const idx = args.findIndex((a) => a === '--agent' || a.startsWith('--agent='));
    if (idx >= 0) {
      const value = args[idx].includes('=') ? args[idx].split('=')[1] : args[idx + 1];
      if (value) return { agent: value.slice(0, 60), procs };
    }
    pid = parent;
  }
  return { agent: null, procs };
}
