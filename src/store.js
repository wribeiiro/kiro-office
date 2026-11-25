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
/** Arquivos que podem descrever a sessão: <id>.json, <id sem "sess_">.json e <id>.history. */
export function sessionFileCandidates(sessionsDir, id) {
  if (!sessionsDir || !/^[\w.-]+$/.test(id)) return [];
  const bare = id.replace(/^sess_/, '');
  const names = [`${id}.json`, `${bare}.json`, `${id}.history`, `${bare}.history`];
  return [...new Set(names)].map((n) => path.join(sessionsDir, n));
}

/** Lê um arquivo JSON, ou JSON Lines (usa até as 20 primeiras linhas como lista). */
export function parseJsonish(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const lines = raw.split('\n').filter((l) => l.trim()).slice(0, 20);
    const parsed = [];
    for (const l of lines) {
      try {
        parsed.push(JSON.parse(l));
      } catch {
        /* linha não é JSON */
      }
    }
    return parsed.length ? { lines: parsed } : null;
  }
}

export function readSessionFile(sessionsDir, id) {
  for (const file of sessionFileCandidates(sessionsDir, id)) {
    try {
      const data = parseJsonish(fs.readFileSync(file, 'utf8').slice(0, 512 * 1024));
      if (data) return data;
    } catch {
      /* não existe */
    }
  }
  return null;
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

/** Agente padrão do Kiro CLI: "chat.defaultAgent" em ~/.kiro/settings/cli.json. */
export function readDefaultAgent(settingsFile) {
  if (!settingsFile) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const v = cfg['chat.defaultAgent'] ?? cfg.chat?.defaultAgent;
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : null;
  } catch {
    return null;
  }
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
    } else if (v === null) {
      out.push({ key: keyPath, type: 'null' });
    } else if (typeof v === 'object') {
      out.push({ key: keyPath, type: Object.keys(v).length ? 'object' : 'object(vazio)' });
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
  constructor({ now = () => Date.now(), sessionsDir = DEFAULT_SESSIONS_DIR, settingsFile } = {}) {
    this.now = now;
    this.sessionsDir = sessionsDir;
    // ~/.kiro/settings/cli.json → "chat.defaultAgent"
    this.settingsFile =
      settingsFile !== undefined ? settingsFile : sessionsDir ? path.resolve(sessionsDir, '..', '..', 'settings', 'cli.json') : null;
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
          .slice(0, 30)
          .map(({ f }) => f);
      }
    } catch {
      /* ignora */
    }
    return {
      sessionsDir: this.sessionsDir,
      sessionsDirExists: dirExists,
      settingsFile: this.settingsFile,
      defaultAgentFromSettings: readDefaultAgent(this.settingsFile),
      newestFilesInSessionsDir: newestFiles,
      sessions: [...this.sessions.values()].map((s) => {
        const candidates = sessionFileCandidates(this.sessionsDir, s.id).map((f) => ({ file: f, exists: fs.existsSync(f) }));
        const data = s.virtual ? null : readSessionFile(this.sessionsDir, s.id);
        return {
          id: s.id,
          name: s.name,
          agent: s.agent,
          agentSource: s.agentSource,
          parentId: s.parentId,
          virtual: s.virtual,
          sessionFileCandidates: candidates,
          sessionFileKeys: data ? describeKeys(data) : [],
        };
      }),
      // estrutura (chaves) do .json e do .history mais recentes da pasta, para descobrir o formato
      sampleFiles: ['.json', '.history', '.jsonl'].map((ext) => {
        const name = newestFiles.find((f) => f.endsWith(ext));
        if (!name) return { ext, file: null };
        try {
          const data = parseJsonish(fs.readFileSync(path.join(this.sessionsDir, name), 'utf8').slice(0, 512 * 1024));
          return { ext, file: name, keys: data ? describeKeys(data).slice(0, 120) : 'não é JSON' };
        } catch (e) {
          return { ext, file: name, error: String(e.message) };
        }
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

    // No Kiro CLI, o subagente usa o MESMO session_id do pai. Enquanto houver um subagente
    // aberto, as ações que chegam nessa sessão são dele, não do pai (que está esperando).
    const tool = String(payload.tool_name ?? payload.toolName ?? '');
    const isDelegateCall = (kind === 'pre_tool' || kind === 'post_tool') && toolCategory(tool) === 'delegate';
    const open = this.#openVirtualKids(s);
    if (open.length && !isDelegateCall && ['pre_tool', 'post_tool', 'permission', 'stop'].includes(kind)) {
      if (open.length === 1) {
        this.#applyEvent(open[0], kind, payload, t);
      } else {
        // vários subagentes em paralelo: não dá para saber de qual é a ação
        for (const k of open) this.#setState(k, 'work', t);
        if (kind === 'pre_tool') this.#log(s, t, `subagentes: ${tool}${summarizeInput(payload.tool_input) ? ` · ${summarizeInput(payload.tool_input)}` : ''}`);
        if (kind === 'permission') this.#applyEvent(s, kind, payload, t);
      }
      s.updatedAt = t;
      return true;
    }

    this.#applyEvent(s, kind, payload, t);
    return true;
  }

  #setState(s, state, t) {
    if (s.state !== state) s.stateAt = t;
    s.state = state;
  }

  #log(s, t, text) {
    s.log.unshift({ t, text });
    if (s.log.length > MAX_LOG) s.log.length = MAX_LOG;
  }

  /** Aplica um evento a uma sessão (real ou subagente virtual). */
  #applyEvent(s, kind, payload, t) {
    const setState = (state) => this.#setState(s, state, t);
    const log = (text) => this.#log(s, t, text);
    const tool = String(payload.tool_name ?? payload.toolName ?? '');

    switch (kind) {
      case 'start':
        setState('idle');
        log(s.parentId ? 'Subagente iniciado' : 'Sessão iniciada');
        break;
      case 'prompt':
        // o usuário voltou a falar com o agente principal: qualquer delegação acabou
        this.#finishDelegation(s, t);
        setState('thinking');
        s.tool = '';
        s.note = '';
        s.detail = summarizeInput(payload.prompt ?? payload.user_prompt ?? '', 120);
        log(s.detail ? `Prompt: ${s.detail}` : 'Novo prompt');
        break;
      case 'pre_tool': {
        const category = toolCategory(tool);
        setState(category);
        s.tool = tool;
        s.detail = summarizeInput(payload.tool_input ?? payload.toolInput);
        // o Kiro manda uma descrição curta junto do comando ("Start Maven build in background")
        const input = payload.tool_input ?? payload.toolInput;
        s.note = input && typeof input.description === 'string' ? summarizeInput(input.description, 80) : '';
        log(`${s.note || tool || 'ferramenta'}${s.detail ? ` · ${s.detail}` : ''}`);
        if (category === 'delegate') {
          s.delegatingSince = t;
          if (/^subagent_/i.test(tool)) this.#createVirtualKid(s, tool, payload, t);
        }
        break;
      }
      case 'post_tool':
        if (toolCategory(tool || s.tool) === 'delegate' && !s.virtual) {
          const kid = this.#openVirtualKids(s).find((k) => k.delegateTool === tool);
          if (kid) this.#finishKid(kid, t);
          else this.#finishDelegation(s, t);
          log(kid ? `Resultado de ${kid.agent || kid.name} recebido` : 'Resultados dos subagentes recebidos');
          if (this.#openVirtualKids(s).length) {
            setState('delegate');
            break;
          }
          s.delegatingSince = null;
        }
        setState('thinking');
        break;
      case 'permission':
        setState('waiting');
        s.tool = tool || s.tool;
        s.detail = summarizeInput(payload.tool_input ?? payload.permission?.command ?? s.detail);
        log(`Aguardando permissão: ${s.tool}`);
        break;
      case 'stop':
        if (s.virtual) {
          // subagente terminou o próprio turno; entrega quando o pai receber o resultado
          setState('done');
          s.tool = '';
          s.detail = '';
          log('Subagente concluiu');
          break;
        }
        this.#finishDelegation(s, t);
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
  }

  /** Subagente do Kiro CLI (mesmo session_id do pai): vira um filhote "virtual". */
  #createVirtualKid(parent, tool, payload, t) {
    parent.kidCounter += 1;
    const input = payload.tool_input ?? {};
    const kid = this.#blank(`${parent.id}#${parent.kidCounter}`, parent.cwd, t);
    kid.parentId = parent.id;
    kid.virtual = true;
    kid.delegateTool = tool;
    kid.name = `sub ${parent.kidCounter}`;
    kid.agent = tool.replace(/^subagent_/i, '') || null;
    kid.state = 'thinking';
    kid.detail = summarizeInput(input.explanation ?? input.prompt ?? input, 120);
    kid.log.unshift({ t, text: `Tarefa: ${kid.detail || tool}` });
    this.sessions.set(kid.id, kid);
    return kid;
  }

  #openVirtualKids(parent) {
    if (parent.virtual) return [];
    const out = [];
    for (const k of this.sessions.values()) if (k.virtual && k.parentId === parent.id && k.state !== 'leaving') out.push(k);
    return out;
  }

  #finishKid(kid, t) {
    kid.state = 'leaving';
    kid.stateAt = t;
    kid.returning = true;
    kid.updatedAt = t;
    kid.log.unshift({ t, text: 'Resultado entregue ao agente principal' });
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

  #blank(id, cwd, t) {
    return {
      id,
      cwd,
      name: '',
      parentId: null,
      virtual: false,
      delegateTool: null,
      note: '',
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
      agentSource: null,
      agentCheckedAt: -Infinity,
    };
  }

  #create(id, cwd, payload, t) {
    const parent = this.#findParent(id, cwd, payload, t);
    const s = this.#blank(id, cwd, t);
    s.parentId = parent?.id ?? null;
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
    if (s.virtual) return;
    // 1) linha de comando do Kiro (--agent) — vem em todo evento, então pode corrigir as outras fontes
    if (typeof payload._agent === 'string' && payload._agent.trim()) {
      s.agent = payload._agent.trim().slice(0, 40);
      s.agentSource = 'linha de comando (--agent)';
      return;
    }
    if (s.agent) return;
    // 2) campo explícito no payload ou variável de ambiente com AGENT_NAME (não KIRO_AGENT_ENGINE)
    const env = payload._env && typeof payload._env === 'object' ? payload._env : {};
    const envAgent = Object.entries(env).find(
      ([k, v]) => /AGENT_?NAME$|^KIRO_AGENT$/i.test(k) && typeof v === 'string' && v.trim(),
    );
    const fromPayload =
      findAgentName({ agent_name: payload.agent_name, agentName: payload.agentName, agent: payload.agent }, 0) ??
      (envAgent ? envAgent[1].trim().slice(0, 40) : null);
    if (fromPayload) {
      s.agent = fromPayload;
      s.agentSource = 'payload';
      return;
    }
    if (t - s.agentCheckedAt < AGENT_RETRY_MS) return;
    s.agentCheckedAt = t;
    // 3) arquivo de sessão; 4) agente padrão das configurações do Kiro
    const fromFile = findAgentName(readSessionFile(this.sessionsDir, s.id));
    if (fromFile) {
      s.agent = fromFile;
      s.agentSource = 'arquivo de sessão';
      return;
    }
    const fromSettings = readDefaultAgent(this.settingsFile);
    if (fromSettings) {
      s.agent = fromSettings;
      s.agentSource = 'agente padrão (settings/cli.json)';
    }
  }

  #findParent(id, cwd, payload, t) {
    const explicit = payload.parent_session_id ?? payload.parentSessionId ?? payload.parent_id;
    const fromFile = explicit ? null : readParentFromSessionFile(this.sessionsDir, id);
    const known = this.sessions.get(String(explicit || fromFile || ''));
    if (known && known.id !== id) return known;

    // Correlação por tempo: só no MESMO diretório e só quando o pai delega por uma ferramenta
    // genérica. Com subagent_* (Kiro CLI) os filhos já são virtuais, e uma sessão nova
    // é outra sessão de verdade, não um subagente.
    const open = [...this.sessions.values()].filter(
      (p) =>
        !p.parentId &&
        p.delegatingSince != null &&
        t - p.delegatingSince < DELEGATION_WINDOW_MS &&
        p.state !== 'leaving' &&
        p.cwd &&
        p.cwd === cwd &&
        !/^subagent_/i.test(p.tool || ''),
    );
    return open.sort((a, b) => b.delegatingSince - a.delegatingSince)[0] ?? null;
  }

  /** O pai recebeu os resultados: os filhos voam até ele, entregam e somem. */
  #finishDelegation(parent, t) {
    parent.delegatingSince = null;
    for (const kid of this.sessions.values()) {
      if (kid.parentId === parent.id && kid.state !== 'leaving') this.#finishKid(kid, t);
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
