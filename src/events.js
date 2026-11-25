// Normalização dos eventos de hook do Kiro CLI e categorização de ferramentas.

/** Converte o nome do evento (PascalCase, camelCase ou legado 2.x) num tipo interno. */
export function normalizeEvent(name) {
  const n = String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');
  switch (n) {
    case 'sessionstart':
    case 'agentspawn':
      return 'start';
    case 'userpromptsubmit':
    case 'promptsubmit':
      return 'prompt';
    case 'pretooluse':
      return 'pre_tool';
    case 'posttooluse':
      return 'post_tool';
    case 'permissionrequest':
      return 'permission';
    case 'stop':
    case 'agentstop':
      return 'stop';
    case 'sessionend':
      return 'end';
    default:
      return null;
  }
}

/** Mapeia o nome da ferramenta para uma animação do personagem. */
export function toolCategory(tool) {
  const t = String(tool ?? '').toLowerCase();
  if (!t) return 'work';
  if (t.startsWith('mcp_') || t.startsWith('@')) return 'mcp';
  if (/(execute_bash|execute_pwsh|execute_cmd|shell|bash|pwsh|terminal)/.test(t)) return 'shell';
  if (/(web_|fetch|http|url|browser)/.test(t)) return 'web';
  if (/(subagent|delegate|use_agent|agent)/.test(t)) return 'delegate';
  if (/(fs_write|fs_append|str_replace|write|edit|delete|create|patch|replace)/.test(t)) return 'write';
  if (/(fs_read|read|glob|grep|search|list|find|ls)/.test(t)) return 'read';
  return 'work';
}

/** Resumo curto do input da ferramenta (comando, caminho, padrão...). */
export function summarizeInput(input, max = 90) {
  if (input == null) return '';
  let text;
  if (typeof input === 'string') {
    text = input;
  } else if (typeof input === 'object') {
    // Ferramentas como "read" do Kiro mandam { operations: [{ mode, path }] }
    const obj = Array.isArray(input.operations) && input.operations[0] && typeof input.operations[0] === 'object' ? input.operations[0] : input;
    const keys = ['command', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'explanation', 'prompt', 'task', 'paths'];
    const key = keys.find((k) => obj[k] != null);
    const value = key ? obj[key] : obj;
    text = typeof value === 'string' ? value : Array.isArray(value) ? value.join(', ') : JSON.stringify(value);
  } else {
    text = String(input);
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
