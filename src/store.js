// Estado em memória das sessões (um fantasma por session_id), com vínculo pai → subagentes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeEvent, toolCategory, summarizeInput } from './events.js';

const MAX_LOG = 8;
export const STALE_MS = 15 * 60 * 1000; // sessão sem eventos por 15 min some do escritório
export const LEAVE_MS = 3000; // animação de saída pela porta
export const RETURN_MS = 5000; // subagente voando até o pai para entregar o resultado
export const DELEGATION_WINDOW_MS = 10 * 60 * 1000; // até quando uma sessão nova pode ser filha de uma delegação
const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), '.kiro', 'sessions', 'cli');

/**
 * Tenta achar o pai de uma sessão no arquivo persistido pelo Kiro CLI
 * (~/.kiro/sessions/cli/<id>.json). O nome exato do campo não é documentado,
 * então aceita qualquer chave "parent…id" com valor string.
 */
export function readSessionFile(sessionsDir, id) {
  if (!sessionsDir || !/^[\w.-]+$/.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionsDir, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export function readParentFromSessionFile(sessionsDir, id) {
  return findParentKey(readSessionFile(sessionsDir, id), 0);
}

/**
 * Nome do agente (perfil do Kiro) a partir de um objeto qualquer: aceita
 * agent_name / agentName / agent (texto) / agent.name, até 3 níveis de profundidade.
 */
export function findAgentName(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase().replace(/[_-]/g, '');
    if (!['agent', 'agentname', 'agentprofile'].includes(key)) continue;
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 40);
    if (v && typeof v === 'object' && typeof v.name === 'string' && v.name.trim()) return v.name.trim().slice(0, 40);
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = findAgentName(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export const AGENT_RETRY_MS = 5000; // tenta de novo ler o arquivo de sessão a cada 5 s até achar o agente

function findParentKey(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v && /^parent.*(session|conversation)?.*id$/i.test(k.replace(/[_-]/g, ''))) return v;
  }
  for (const v of Object.values(obj)) {
    const found = findParentKey(v, depth + 1);
    if (found) return found;
  }
  return null;
}

const INTERESTING_KEY = /agent|name|profile|model|parent|session/i;

/** Lista os caminhos de chave de um objeto (até 4 níveis), com valor só para chaves "interessantes". */
export function describeKeys(obj, prefix = '', depth = 0, out = []) {
  if (!obj || typeof obj !== 'object' || depth > 4 || out.length > 200) return out;
  for (const [k, v] of Object.entries(obj)) {
    const keyPath = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      out.push({ key: keyPath, type: `array(${v.length})` });
      if (v[0] && typeof v[0] === 'object') describeKeys(v[0], `${keyPath}[0]`, depth + 1, out);
    } else if (v && typeof v === 'object') {
      out.push({ key: keyPath, type: 'object' });
      describeKeys(v, keyPath, depth + 1, out);
    } else {
      const entry = { key: keyPath, type: typeof v };
      if (INTERESTING_KEY.test(k) && (typeof v === 'string' || typeof v === 'number')) entry.value = String(v).slice(0, 80);
      out.push(entry);
    }
  }
  return out;
}

const truncateStrings = (value, depth = 0) => {
  if (typeof value === 'string') return value.length > 200 ? value.slice(0, 200) + '…' : value;
  if (!value || typeof value !== 'object' || depth > 5) return value;
  if (Array.isArray(value)) return value.slice(0, 10).map((v) => truncateStrings(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateStrings(v, depth + 1)]));
};

export class SessionStore {
  constructor({ now = () => Date.now(), sessionsDir = DEFAULT_SESSIONS_DIR } = {}) {
    this.now = now;
    this.sessionsDir = sessionsDir;
    this.sessions = new Map();
    this.recent = []; // últimos payloads recebidos (diagnóstico)
  }

  /** Dados para /api/debug: payloads crus, pasta de sessões e campos dos arquivos de sessão. */
  debug() {
    let dirExists = false;
    let newestFiles = [];
    try {
      dirExists = !!this.sessionsDir && fs.statSync(this.sessionsDir).isDirectory();
      if (dirExists) {
        newestFiles = fs
          .readdirSync(this.sessionsDir)
          .map((f) => ({ f, m: fs.statSync(path.join(this.sessionsDir, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m)
          .slice(0, 8)
          .map(({ f }) => f);
      }
    } catch {
      /* ignora */
    }
    return {
      sessionsDir: this.sessionsDir,
      sessionsDirExists: dirExists,
      newestFilesInSessionsDir: newestFiles,
      sessions: [...this.sessions.values()].map((s) => {
        const file = this.sessionsDir ? path.join(this.sessionsDir, `${s.id}.json`) : null;
        const data = readSessionFile(this.sessionsDir, s.id);
        return {
          id: s.id,
          name: s.name,
          agent: s.agent,
          parentId: s.parentId,
          sessionFile: file,
          sessionFileFound: !!data,
          sessionFileKeys: data ? describeKeys(data) : [],
        };
      }),
      recentPayloads: this.recent,
    };
  }

  /** Aplica um payload vindo do hook. Retorna true se o estado mudou. */
  apply(payload) {
    if (!payload || typeof payload !== 'object') return false;
    this.recent.unshift({ t: this.now(), payload: truncateStrings(payload) });
    if (this.recent.length > 15) this.recent.length = 15;
    const kind = normalizeEvent(payload.hook_event_name) ?? normalizeEvent(payload._event);
    if (!kind) return false;

    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
    const id = String(payload.session_id || payload.sessionId || cwd || 'desconhecida');
    const t = this.now();

    let s = this.sessions.get(id);
    if (!s) {
      if (kind === 'end') return false;
      s = this.#create(id, cwd, payload, t);
    }
    if (cwd && !s.cwd) s.cwd = cwd;
    this.#resolveAgent(s, payload, t);

    const setState = (state) => {
      if (s.state !== state) s.stateAt = t;
      s.state = state;
    };
    const log = (text) => {
      s.log.unshift({ t, text });
      if (s.log.length > MAX_LOG) s.log.length = MAX_LOG;
    };

    switch (kind) {
      case 'start':
        setState('idle');
        log(s.parentId ? 'Subagente iniciado' : 'Sessão iniciada');
        break;
      case 'prompt':
        setState('thinking');
        s.tool = '';
        s.detail = summarizeInput(payload.prompt ?? payload.user_prompt ?? '', 120);
        log(s.detail ? `Prompt: ${s.detail}` : 'Novo prompt');
        break;
      case 'pre_tool': {
        const tool = String(payload.tool_name ?? payload.toolName ?? '');
        const category = toolCategory(tool);
        setState(category);
        s.tool = tool;
        s.detail = summarizeInput(payload.tool_input ?? payload.toolInput);
        if (category === 'delegate') s.delegatingSince = t;
        log(`${tool || 'ferramenta'}${s.detail ? ` · ${s.detail}` : ''}`);
        break;
      }
      case 'post_tool':
        if (s.delegatingSince != null && toolCategory(payload.tool_name ?? s.tool) === 'delegate') {
          this.#finishDelegation(s, t);
          log('Resultados dos subagentes recebidos');
        }
        setState('thinking');
        break;
      case 'permission':
        setState('waiting');
        s.tool = String(payload.tool_name ?? s.tool ?? '');
        s.detail = summarizeInput(payload.tool_input ?? payload.permission?.command ?? s.detail);
        log(`Aguardando permissão: ${s.tool}`);
        break;
      case 'stop':
        if (s.delegatingSince != null) this.#finishDelegation(s, t);
        setState('done');
        s.tool = '';
        s.detail = '';
        log('Turno concluído');
        break;
      case 'end':
        this.#finishDelegation(s, t);
        setState('leaving');
        log('Sessão encerrada');
        break;
    }
    s.updatedAt = t;
    return true;
  }

  /** Remove sessões encerradas, abandonadas ou subagentes órfãos. Retorna true se algo mudou. */
  sweep() {
    const t = this.now();
    let changed = false;
    for (const [id, s] of this.sessions) {
      let gone;
      if (s.state === 'leaving') gone = t - s.stateAt > (s.returning ? RETURN_MS : LEAVE_MS);
      else if (s.parentId && !this.sessions.has(s.parentId)) gone = true;
      else gone = t - s.updatedAt > STALE_MS;
      if (gone) {
        this.sessions.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  snapshot() {
    return {
      now: this.now(),
      sessions: [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt),
    };
  }

  #create(id, cwd, payload, t) {
    const parent = this.#findParent(id, cwd, payload, t);
    const s = {
      id,
      cwd,
      name: '',
      parentId: parent?.id ?? null,
      state: 'idle',
      tool: '',
      detail: '',
      log: [],
      createdAt: t,
      updatedAt: t,
      stateAt: t,
      delegatingSince: null,
      kidCounter: 0,
      returning: false,
      agent: null,
      agentCheckedAt: -Infinity,
    };
    if (parent) {
      parent.kidCounter += 1;
      s.name = `sub ${parent.kidCounter}`;
      parent.log.unshift({ t, text: `Subagente ${s.name} criado` });
    } else {
      s.name = this.#uniqueName(path.basename(cwd) || 'kiro');
    }
    this.sessions.set(id, s);
    return s;
  }

  /** Pai explícito no payload → arquivo de sessão do Kiro → correlação com uma delegação aberta. */
  /** Nome do agente: primeiro no payload do hook, depois no arquivo de sessão do Kiro (com nova tentativa). */
  #resolveAgent(s, payload, t) {
    if (s.agent) return;
    const fromPayload = findAgentName(
      { agent_name: payload.agent_name, agentName: payload.agentName, agent: payload.agent },
      0,
    );
    if (fromPayload) {
      s.agent = fromPayload;
      return;
    }
    if (!this.sessionsDir || t - s.agentCheckedAt < AGENT_RETRY_MS) return;
    s.agentCheckedAt = t;
    s.agent = findAgentName(readSessionFile(this.sessionsDir, s.id));
  }

  #findParent(id, cwd, payload, t) {
    const explicit = payload.parent_session_id ?? payload.parentSessionId ?? payload.parent_id;
    const fromFile = explicit ? null : readParentFromSessionFile(this.sessionsDir, id);
    const known = this.sessions.get(String(explicit || fromFile || ''));
    if (known && known.id !== id) return known;

    const open = [...this.sessions.values()].filter(
      (p) => !p.parentId && p.delegatingSince != null && t - p.delegatingSince < DELEGATION_WINDOW_MS && p.state !== 'leaving',
    );
    if (open.length === 0) return null;
    const sameCwd = open.filter((p) => p.cwd && p.cwd === cwd);
    const pool = sameCwd.length ? sameCwd : open.length === 1 ? open : [];
    return pool.sort((a, b) => b.delegatingSince - a.delegatingSince)[0] ?? null;
  }

  /** O pai recebeu os resultados: os filhos voam até ele, entregam e somem. */
  #finishDelegation(parent, t) {
    parent.delegatingSince = null;
    for (const kid of this.sessions.values()) {
      if (kid.parentId !== parent.id || kid.state === 'leaving') continue;
      kid.state = 'leaving';
      kid.stateAt = t;
      kid.returning = true;
      kid.updatedAt = t;
      kid.log.unshift({ t, text: 'Resultado entregue ao agente principal' });
    }
  }

  #uniqueName(base) {
    const names = new Set([...this.sessions.values()].filter((s) => !s.parentId).map((s) => s.name));
    if (!names.has(base)) return base;
    let i = 2;
    while (names.has(`${base} #${i}`)) i++;
    return `${base} #${i}`;
  }
}
