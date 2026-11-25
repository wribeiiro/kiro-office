#!/usr/bin/env node
// Simula sessões do Kiro CLI enviando eventos para o servidor (para testar sem o kiro-cli).
// Uso: npm run demo  (com o servidor rodando em outro terminal)
const port = Number(process.env.KIRO_OFFICE_PORT) || 4317;
const url = `http://127.0.0.1:${port}/api/event`;

const PROJECTS = ['/home/dev/stark/jarvis-core', '/home/dev/nutribee', '/home/dev/kiro-agents', '/home/dev/wayne/batcomputer'];
const TOOLS = [
  ['fs_read', { path: 'src/main/java/App.java' }],
  ['grep', { pattern: 'TODO', path: 'src' }],
  ['fs_write', { path: 'src/components/Button.tsx' }],
  ['str_replace', { path: 'README.md' }],
  ['execute_bash', { command: 'npm test' }],
  ['execute_bash', { command: 'git status' }],
  ['web_fetch', { url: 'https://kiro.dev/docs/hooks/' }],
  ['mcp_jira_get_issue', { query: 'TITAN-1234' }],
  ['subagent_stark-bruce-wayne', { explanation: 'Corrigir os achados de SAST' }],
  ['subagent_explorer', { explanation: 'Mapear o módulo de auth' }],
];
const AGENTS = ['stark-sexta-feira', 'titan', 'curie', 'kiro_default'];
const PROMPTS = ['implemente o endpoint de exportação', 'por que esse teste está falhando?', 'refatore o módulo de auth', 'escreva a steering de testes'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const post = (body) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {
    console.error(`Não consegui falar com ${url}. O servidor está rodando? (npm start)`);
    process.exit(1);
  });

/** Como no Kiro CLI: o subagente usa o mesmo session_id do pai até o PostToolUse da ferramenta subagent_*. */
async function runSubagent(ev) {
  const SUB_TOOLS = TOOLS.filter(([t]) => !t.startsWith('subagent_'));
  for (let j = 0; j < 3 + Math.floor(Math.random() * 3); j++) {
    const [tool_name, tool_input] = pick(SUB_TOOLS);
    await ev('PreToolUse', { tool_name, tool_input });
    await sleep(1800 + Math.random() * 2200);
    await ev('PostToolUse', { tool_name, tool_input });
  }
  await sleep(600);
}

async function runSession(i) {
  const session_id = `demo-${i}-${Date.now().toString(36)}`;
  const cwd = PROJECTS[i % PROJECTS.length];
  const agent_name = AGENTS[i % AGENTS.length];
  const ev = (hook_event_name, extra = {}) => post({ hook_event_name, session_id, cwd, agent_name, ...extra });

  await sleep(i * 1200);
  await ev('SessionStart');
  for (let turn = 0; turn < 4; turn++) {
    // pausas longas entre turnos para os fantasmas irem ao café
    await sleep(turn === 0 ? 1500 : 3000 + Math.random() * 15000);
    await ev('UserPromptSubmit', { prompt: pick(PROMPTS) });
    await sleep(1500);
    const steps = 2 + Math.floor(Math.random() * 4);
    for (let k = 0; k < steps; k++) {
      const [tool_name, tool_input] = pick(TOOLS);
      await ev('PreToolUse', { tool_name, tool_input });
      if (tool_name === 'execute_bash' && Math.random() < 0.4) {
        await ev('PermissionRequest', { tool_name, tool_input });
        await sleep(4000);
      }
      if (tool_name.startsWith('subagent_')) await runSubagent(ev);
      else await sleep(1500 + Math.random() * 2000);
      await ev('PostToolUse', { tool_name, tool_input });
      await sleep(600);
    }
    await ev('Stop');
  }
  await sleep(4000);
  await ev('SessionEnd');
}

console.log(`Simulando 4 sessões em ${url} (Ctrl+C para parar)…`);
for (;;) {
  await Promise.all([0, 1, 2, 3].map(runSession));
}
