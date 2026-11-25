// Estado em memória das sessões (um personagem por session_id).
import path from 'node:path';
import { normalizeEvent, toolCategory, summarizeInput } from './events.js';

const MAX_LOG = 8;
export const STALE_MS = 15 * 60 * 1000; // sessão sem eventos por 15 min some do escritório
export const LEAVE_MS = 3000; // tempo da animação de saída

export class SessionStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.sessions = new Map();
  }

  /** Aplica um payload vindo do hook. Retorna true se o estado mudou. */
  apply(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const kind = normalizeEvent(payload.hook_event_name) ?? normalizeEvent(payload._event);
    if (!kind) return false;

    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
    const id = String(payload.session_id || payload.sessionId || cwd || 'desconhecida');
    const t = this.now();

    let s = this.sessions.get(id);
    if (!s) {
      if (kind === 'end') return false;
      s = {
        id,
        cwd,
        name: this.#uniqueName(path.basename(cwd) || 'kiro'),
        state: 'idle',
        tool: '',
        detail: '',
        log: [],
        createdAt: t,
        updatedAt: t,
        stateAt: t,
      };
      this.sessions.set(id, s);
    }
    if (cwd && !s.cwd) s.cwd = cwd;

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
        log('Sessão iniciada');
        break;
      case 'prompt': {
        setState('thinking');
        s.tool = '';
        s.detail = summarizeInput(payload.prompt ?? payload.user_prompt ?? '', 120);
        log(s.detail ? `Prompt: ${s.detail}` : 'Novo prompt');
        break;
      }
      case 'pre_tool': {
        const tool = String(payload.tool_name ?? payload.toolName ?? '');
        setState(toolCategory(tool));
        s.tool = tool;
        s.detail = summarizeInput(payload.tool_input ?? payload.toolInput);
        log(`${tool || 'ferramenta'}${s.detail ? ` · ${s.detail}` : ''}`);
        break;
      }
      case 'post_tool':
        setState('thinking');
        break;
      case 'permission': {
        setState('waiting');
        const tool = String(payload.tool_name ?? s.tool ?? '');
        s.tool = tool;
        s.detail = summarizeInput(payload.tool_input ?? payload.permission?.command ?? s.detail);
        log(`Aguardando permissão: ${tool}`);
        break;
      }
      case 'stop':
        setState('done');
        s.tool = '';
        s.detail = '';
        log('Turno concluído');
        break;
      case 'end':
        setState('leaving');
        log('Sessão encerrada');
        break;
    }
    s.updatedAt = t;
    return true;
  }

  /** Remove sessões encerradas ou abandonadas. Retorna true se algo mudou. */
  sweep() {
    const t = this.now();
    let changed = false;
    for (const [id, s] of this.sessions) {
      const gone = s.state === 'leaving' ? t - s.stateAt > LEAVE_MS : t - s.updatedAt > STALE_MS;
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

  #uniqueName(base) {
    const names = new Set([...this.sessions.values()].map((s) => s.name));
    if (!names.has(base)) return base;
    let i = 2;
    while (names.has(`${base} #${i}`)) i++;
    return `${base} #${i}`;
  }
}
