import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeEvent, toolCategory, summarizeInput } from '../src/events.js';
import { SessionStore, STALE_MS, LEAVE_MS, RETURN_MS, readParentFromSessionFile } from '../src/store.js';
import { createOfficeServer } from '../src/server.js';
import { installHooks, uninstallHooks, listHooks, TRIGGERS } from '../src/hooks-installer.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('normalizeEvent aceita PascalCase, camelCase e nomes legados', () => {
  assert.equal(normalizeEvent('SessionStart'), 'start');
  assert.equal(normalizeEvent('agentSpawn'), 'start');
  assert.equal(normalizeEvent('UserPromptSubmit'), 'prompt');
  assert.equal(normalizeEvent('preToolUse'), 'pre_tool');
  assert.equal(normalizeEvent('PostToolUse'), 'post_tool');
  assert.equal(normalizeEvent('permissionRequest'), 'permission');
  assert.equal(normalizeEvent('Stop'), 'stop');
  assert.equal(normalizeEvent('SessionEnd'), 'end');
  assert.equal(normalizeEvent('PreCompact'), null);
});

test('toolCategory mapeia ferramentas do Kiro CLI', () => {
  assert.equal(toolCategory('fs_read'), 'read');
  assert.equal(toolCategory('grep'), 'read');
  assert.equal(toolCategory('fs_write'), 'write');
  assert.equal(toolCategory('str_replace'), 'write');
  assert.equal(toolCategory('execute_bash'), 'shell');
  assert.equal(toolCategory('web_search'), 'web');
  assert.equal(toolCategory('mcp_jira_get_issue'), 'mcp');
  assert.equal(toolCategory('use_subagent'), 'delegate');
  assert.equal(toolCategory('algo_novo'), 'work');
});

test('summarizeInput resume comando/caminho e trunca', () => {
  assert.equal(summarizeInput({ command: 'npm   test' }), 'npm test');
  assert.equal(summarizeInput({ path: 'a/b.ts', mode: 'Line' }), 'a/b.ts');
  assert.equal(summarizeInput('x'.repeat(200), 10).length, 10);
});

test('SessionStore segue o ciclo de vida de uma sessão', () => {
  let now = 1000;
  const store = new SessionStore({ now: () => now });
  const base = { session_id: 's1', cwd: '/proj/app' };
  store.apply({ ...base, hook_event_name: 'SessionStart' });
  let s = store.snapshot().sessions[0];
  assert.equal(s.name, 'app');
  assert.equal(s.state, 'idle');

  store.apply({ ...base, hook_event_name: 'PreToolUse', tool_name: 'execute_bash', tool_input: { command: 'ls' } });
  s = store.snapshot().sessions[0];
  assert.equal(s.state, 'shell');
  assert.equal(s.detail, 'ls');

  store.apply({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'execute_bash' });
  assert.equal(store.snapshot().sessions[0].state, 'waiting');
  store.apply({ ...base, hook_event_name: 'Stop' });
  assert.equal(store.snapshot().sessions[0].state, 'done');

  store.apply({ ...base, hook_event_name: 'SessionEnd' });
  assert.equal(store.snapshot().sessions[0].state, 'leaving');
  now += LEAVE_MS + 1;
  store.sweep();
  assert.equal(store.snapshot().sessions.length, 0);
});

test('SessionStore usa _event quando hook_event_name falta, nomeia duplicadas e limpa inativas', () => {
  let now = 0;
  const store = new SessionStore({ now: () => now });
  store.apply({ _event: 'PreToolUse', session_id: 'a', cwd: '/x/app', tool_name: 'fs_read' });
  store.apply({ hook_event_name: 'SessionStart', session_id: 'b', cwd: '/y/app' });
  const names = store.snapshot().sessions.map((s) => s.name);
  assert.deepEqual(names, ['app', 'app #2']);
  assert.equal(store.apply({ hook_event_name: 'Bogus', session_id: 'a' }), false);
  now += STALE_MS + 1;
  store.sweep();
  assert.equal(store.snapshot().sessions.length, 0);
});

test('instalador escreve um arquivo de hook por gatilho e remove depois', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-office-'));
  const files = installHooks({ home });
  assert.equal(files.length, TRIGGERS.length);
  const json = JSON.parse(fs.readFileSync(files[0], 'utf8'));
  assert.equal(json.version, 'v1');
  assert.equal(json.hooks[0].trigger, 'SessionStart');
  assert.match(json.hooks[0].action.command, /send\.js" SessionStart$/);
  assert.equal(listHooks({ home }).length, TRIGGERS.length);
  uninstallHooks({ home });
  assert.equal(listHooks({ home }).length, 0);
});

function runSend(port, payload, trigger) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'hooks', 'send.js'), trigger], {
      env: { ...process.env, KIRO_OFFICE_PORT: String(port), USER_PROMPT: 'olá kiro' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const started = Date.now();
    child.on('exit', (code) => resolve({ code, out, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('hook send.js entrega o evento ao servidor sem escrever no stdout', async () => {
  const { server } = createOfficeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const r = await runSend(port, { hook_event_name: 'UserPromptSubmit', session_id: 'x1', cwd: '/tmp/proj' }, 'UserPromptSubmit');
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(state.sessions[0].state, 'thinking');
    assert.equal(state.sessions[0].detail, 'olá kiro');
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /Kiro Office/);
  } finally {
    server.close();
  }
});

test('hook send.js sai com 0 e rápido quando o servidor está desligado', async () => {
  const r = await runSend(1, { hook_event_name: 'Stop', session_id: 'x' }, 'Stop');
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.ok(r.ms < 1800, `demorou ${r.ms}ms`);
});

test('summarizeInput entende operations da ferramenta read do Kiro', () => {
  assert.equal(summarizeInput({ operations: [{ mode: 'Line', path: '/p/docs/hooks.md' }] }), '/p/docs/hooks.md');
});

test('subagentes são vinculados ao pai por correlação e entregam o resultado no fim', () => {
  let now = 0;
  const store = new SessionStore({ now: () => now, sessionsDir: null });
  const cwd = '/proj/app';
  store.apply({ hook_event_name: 'SessionStart', session_id: 'pai', cwd });
  store.apply({ hook_event_name: 'SessionStart', session_id: 'outro', cwd: '/proj/outro' });
  store.apply({ hook_event_name: 'PreToolUse', session_id: 'pai', cwd, tool_name: 'use_subagent', tool_input: { query: 'x' } });
  now += 500;
  store.apply({ hook_event_name: 'SessionStart', session_id: 'k1', cwd });
  store.apply({ hook_event_name: 'PreToolUse', session_id: 'k2', cwd, tool_name: 'fs_read' });
  const byId = (id) => store.snapshot().sessions.find((s) => s.id === id);
  assert.equal(byId('k1').parentId, 'pai');
  assert.equal(byId('k1').name, 'sub 1');
  assert.equal(byId('k2').parentId, 'pai');
  assert.equal(byId('k2').name, 'sub 2');
  assert.equal(byId('outro').parentId, null);

  store.apply({ hook_event_name: 'PostToolUse', session_id: 'pai', cwd, tool_name: 'use_subagent' });
  assert.equal(byId('k1').state, 'leaving');
  assert.equal(byId('k1').returning, true);
  assert.equal(byId('pai').delegatingSince, null);

  // sessão nova depois da delegação fechada é independente
  store.apply({ hook_event_name: 'SessionStart', session_id: 'nova', cwd });
  assert.equal(byId('nova').parentId, null);
  assert.equal(byId('nova').name, 'app #2');

  now += RETURN_MS + 1;
  store.sweep();
  assert.equal(byId('k1'), undefined);
});

test('pai explícito no payload ou no arquivo de sessão tem prioridade', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-sessions-'));
  fs.writeFileSync(path.join(dir, 'k9.json'), JSON.stringify({ cwd: '/a', meta: { parent_session_id: 'p2' } }));
  assert.equal(readParentFromSessionFile(dir, 'k9'), 'p2');
  assert.equal(readParentFromSessionFile(dir, '../etc'), null);

  const store = new SessionStore({ sessionsDir: dir });
  store.apply({ hook_event_name: 'SessionStart', session_id: 'p1', cwd: '/a' });
  store.apply({ hook_event_name: 'SessionStart', session_id: 'p2', cwd: '/b' });
  store.apply({ hook_event_name: 'SessionStart', session_id: 'k8', cwd: '/c', parent_session_id: 'p1' });
  store.apply({ hook_event_name: 'SessionStart', session_id: 'k9', cwd: '/c' });
  const byId = (id) => store.snapshot().sessions.find((s) => s.id === id);
  assert.equal(byId('k8').parentId, 'p1');
  assert.equal(byId('k9').parentId, 'p2');

  // pai encerrado → filhos órfãos somem
  store.apply({ hook_event_name: 'SessionEnd', session_id: 'p1' });
  assert.equal(byId('k8').state, 'leaving');
});
