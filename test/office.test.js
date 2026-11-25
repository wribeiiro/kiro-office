import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeEvent, toolCategory, summarizeInput } from '../src/events.js';
import { SessionStore, STALE_MS, LEAVE_MS } from '../src/store.js';
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
