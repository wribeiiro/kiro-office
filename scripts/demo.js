#!/usr/bin/env node
// Simula sessões do Kiro CLI enviando eventos para o servidor (para testar sem o kiro-cli).
// Uso: npm run demo  (com o servidor rodando em outro terminal)
const port = Number(process.env.KIRO_OFFICE_PORT) || 4317;
const url = `http://127.0.0.1:${port}/api/event`;

const PROJECTS = ['/home/dev/softexpert/generic-core', '/home/dev/nutribee', '/home/dev/kiro-agents', '/home/dev/softexpert/portal'];
const TOOLS = [
  ['fs_read', { path: 'src/main/java/App.java' }],
  ['grep', { pattern: 'TODO', path: 'src' }],
  ['fs_write', { path: 'src/components/Button.tsx' }],
  ['str_replace', { path: 'README.md' }],
  ['execute_bash', { command: 'npm test' }],
  ['execute_bash', { command: 'git status' }],
  ['web_fetch', { url: 'https://kiro.dev/docs/hooks/' }],
  ['mcp_jira_get_issue', { query: 'GEN-1234' }],
  ['use_subagent', { query: 'revisar a PR' }],
  ['use_subagent', { query: 'investigar testes falhando' }],
];
const AGENTS = ['dev-agent', 'reviewer', 'spec-writer', 'kiro_default'];
const SUB_AGENTS = ['explorer', 'tester', 'doc-reader'];
const PROMPTS = ['implemente o endpoint de exportação', 'por que esse teste está falhando?', 'refatore o módulo de auth', 'escreva a steering de testes'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const post = (body) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {
    console.error(`Não consegui falar com ${url}. O servidor está rodando? (npm start)`);
    process.exit(1);
  });

/** Subagentes em paralelo: sessões novas no mesmo cwd, logo depois do use_subagent do pai. */
async function runSubagents(cwd, n) {
  const SUB_TOOLS = TOOLS.filter(([t]) => t !== 'use_subagent');
  await Promise.all(
    Array.from({ length: n }, async (_, k) => {
      const session_id = `sub-${k}-${Math.random().toString(36).slice(2, 8)}`;
      const agent_name = SUB_AGENTS[k % SUB_AGENTS.length];
      const ev = (hook_event_name, extra = {}) => post({ hook_event_name, session_id, cwd, agent_name, ...extra });
      await sleep(300 + k * 400);
      await ev('SessionStart');
      for (let j = 0; j < 2 + Math.floor(Math.random() * 3); j++) {
        const [tool_name, tool_input] = pick(SUB_TOOLS);
        await ev('PreToolUse', { tool_name, tool_input });
        await sleep(1800 + Math.random() * 2200);
        await ev('PostToolUse', { tool_name, tool_input });
      }
      await ev('Stop');
    }),
  );
  await sleep(800);
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
      if (tool_name === 'use_subagent') await runSubagents(cwd, 2 + Math.floor(Math.random() * 2));
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
