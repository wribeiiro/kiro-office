#!/usr/bin/env node
import { createOfficeServer } from '../src/server.js';
import { installHooks, uninstallHooks, listHooks, hooksDir } from '../src/hooks-installer.js';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(`--${name}`);
const option = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const workspace = flag('workspace');

switch (cmd) {
  case 'start': {
    const port = Number(option('port') || process.env.KIRO_OFFICE_PORT) || 4317;
    const { server } = createOfficeServer();
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') console.error(`A porta ${port} já está em uso. Use --port <n> (e KIRO_OFFICE_PORT nos hooks).`);
      else console.error(err);
      process.exit(1);
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`Kiro Office rodando em http://127.0.0.1:${port}`);
      const installed = listHooks();
      if (installed.length === 0) console.log('Dica: os hooks globais ainda não foram instalados. Rode: kiro-office install-hooks');
      console.log('Ctrl+C para sair.');
    });
    process.on('SIGINT', () => server.close(() => process.exit(0)));
    break;
  }

  case 'install-hooks': {
    const files = installHooks({ workspace });
    console.log(`Hooks instalados em ${hooksDir({ workspace })}:`);
    for (const f of files) console.log(`  + ${f}`);
    console.log('\nAbra uma nova sessão do kiro-cli para os hooks serem carregados (confira com /hooks).');
    break;
  }

  case 'uninstall-hooks': {
    const files = uninstallHooks({ workspace });
    if (files.length === 0) console.log('Nenhum hook do kiro-office encontrado.');
    for (const f of files) console.log(`  - ${f}`);
    break;
  }

  case 'status': {
    const files = listHooks({ workspace });
    console.log(`Diretório: ${hooksDir({ workspace })}`);
    console.log(files.length ? files.map((f) => `  ✓ ${f}`).join('\n') : '  (nenhum hook do kiro-office instalado)');
    break;
  }

  default:
    console.log(`kiro-office — escritório pixel-art para sessões do Kiro CLI

Uso:
  kiro-office start [--port 4317]        Sobe o escritório em http://127.0.0.1:4317
  kiro-office install-hooks [--workspace] Instala os hooks (global em ~/.kiro/hooks, ou no projeto atual)
  kiro-office uninstall-hooks [--workspace]
  kiro-office status [--workspace]       Lista os hooks instalados

Variáveis:
  KIRO_OFFICE_PORT   Porta usada pelo servidor e pelos hooks (padrão 4317)`);
}
