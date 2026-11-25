// Instala/remove os arquivos de hook do Kiro CLI (um arquivo por gatilho).
// Um arquivo por gatilho isola falhas: se alguma versão do CLI não reconhecer um gatilho,
// os demais continuam funcionando.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TRIGGERS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
];

const PREFIX = 'kiro-office-';
const SEND_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'send.js');

export function hooksDir({ workspace = false, cwd = process.cwd(), home = os.homedir() } = {}) {
  return workspace ? path.join(cwd, '.kiro', 'hooks') : path.join(home, '.kiro', 'hooks');
}

export function hookFileContent(trigger, { nodePath = process.execPath, sendScript = SEND_SCRIPT } = {}) {
  return {
    version: 'v1',
    hooks: [
      {
        name: `${PREFIX}${trigger}`,
        description: 'Kiro Office: envia o evento para o escritório pixel-art local (não altera o agente).',
        trigger,
        action: {
          type: 'command',
          command: `"${nodePath}" "${sendScript}" ${trigger}`,
        },
      },
    ],
  };
}

export function installHooks(opts = {}) {
  const dir = hooksDir(opts);
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const trigger of opts.triggers ?? TRIGGERS) {
    const file = path.join(dir, `${PREFIX}${trigger}.json`);
    fs.writeFileSync(file, JSON.stringify(hookFileContent(trigger, opts), null, 2) + '\n');
    written.push(file);
  }
  return written;
}

export function listHooks(opts = {}) {
  const dir = hooksDir(opts);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith('.json'))
    .map((f) => path.join(dir, f));
}

export function uninstallHooks(opts = {}) {
  const files = listHooks(opts);
  for (const f of files) fs.unlinkSync(f);
  return files;
}
