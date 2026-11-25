# Kiro Office

Um escritório em pixel-art, rodando localmente, onde cada sessão do **Kiro CLI** vira um fantasminha. Ele digita quando o agente escreve código, lê quando busca arquivos, mostra o terminal quando roda comandos e levanta a mãozinha com um **"!"** quando precisa da sua permissão. Quando fica ocioso, vai flutuando até o **café** tomar um cafezinho, e volta para a mesa assim que chega um novo prompt.

Inspirado no [Pixel Agents](https://github.com/pablodelucca/pixel-agents), que hoje só suporta o Claude Code. Este é um MVP próprio para o Kiro CLI, sem dependências e sem assets de terceiros: os fantasminhas e o cenário são desenhados em código.

![Kiro Office](docs/screenshot.png)

## Como funciona

```
kiro-cli ──(hooks)──▶ hooks/send.js ──POST──▶ servidor local :4317 ──SSE──▶ navegador (canvas)
```

1. **Hooks globais** em `~/.kiro/hooks/` disparam a cada evento da sessão (início, prompt, uso de ferramenta, pedido de permissão, fim do turno, fim da sessão).
2. O **`hooks/send.js`** lê o JSON do STDIN e repassa para o servidor local. Ele **nunca escreve no STDOUT** (que iria para o contexto do agente), **sempre sai com código 0** e termina em até 1,5 s, mesmo com o servidor desligado. Não bloqueia nem altera nada no agente.
3. O **servidor** (Node puro) guarda o estado por `session_id` e transmite para o navegador via Server-Sent Events.
4. O **navegador** desenha o escritório em canvas e mostra um painel com o log de cada sessão.

| Evento do Kiro CLI | Fantasminha |
|---|---|
| `SessionStart` | entra pela porta do café e flutua até a mesa |
| `UserPromptSubmit` | pensando (balão "...") |
| `PreToolUse` | `fs_read`/`grep` → lendo · `fs_write`/`str_replace` → escrevendo · `execute_bash` → terminal · `web_*` → web · `mcp_*` → MCP · `use_subagent` → delegando |
| `PostToolUse` | volta a pensar |
| `PermissionRequest` | mão levantada + **"!"** vermelho (a aba do navegador pisca) |
| `Stop` | comemora ✓; depois de alguns segundos ocioso, vai para o café ☕ |
| `SessionEnd` | sai pela porta e some |

Os **balões de fala** mostram a ação atual: `lendo App.java`, `editando Button.tsx`, `$ npm test`, `web kiro.dev`, `mcp jira:get_issue`, `delegando → 3 sub`, `permitir? git status` (em vermelho) e `pronto! ✓`.

### Subagentes

Quando um agente delega, cada subagente vira um **filhote** da mesma cor do pai. O filhote nasce da mesa do pai, com um aviãozinho de papel levando a tarefa, e fica na frente da mesa ligado ao pai por uma linha pontilhada. No painel lateral, os filhotes aparecem aninhados no card do pai, cada um com a sua ação. Quando o pai recebe os resultados (`PostToolUse` da ferramenta de subagente), os filhotes voam até ele carregando um papel, entregam e somem.

Para saber quem é pai de quem, o servidor tenta, nesta ordem:
1. um campo de pai no payload do hook (`parent_session_id`, `parentSessionId` ou `parent_id`), se o Kiro enviar;
2. o arquivo da sessão em `~/.kiro/sessions/cli/<session_id>.json`, procurando um campo `parent…id`;
3. **correlação por tempo:** uma sessão nova que aparece enquanto outra, no mesmo diretório, está com uma delegação aberta é considerada filha dela.

Limitação: os filhotes só aparecem se os hooks globais dispararem dentro dos subagentes com um `session_id` próprio. Se não dispararem, o pai mostra só `delegando…`. Uma sessão nova aberta no mesmo projeto enquanto outra está delegando pode ser confundida com um filho.

Os agentes não conversam entre si: no Kiro, o pai manda a tarefa e cada subagente devolve o resultado ao pai.

## Requisitos

- Node.js 20+
- Kiro CLI V3 (o `PermissionRequest` exige a versão 3.4.0 ou mais nova)

## Instalação e uso

```bash
git clone https://github.com/wribeiiro/kiro-office.git
cd kiro-office

# 1. sobe o escritório
npm start                       # http://127.0.0.1:4317

# 2. (opcional) testa sem o kiro-cli, em outro terminal
npm run demo

# 3. instala os hooks globais (~/.kiro/hooks/kiro-office-*.json)
npm run install-hooks
```

Depois abra uma **nova** sessão do `kiro-cli`, em qualquer projeto, e confira com `/hooks` se os hooks `kiro-office-*` foram carregados.

Outros comandos:

```bash
node bin/kiro-office.js status                 # lista os hooks instalados
node bin/kiro-office.js install-hooks --workspace  # instala só no projeto atual (.kiro/hooks)
npm run uninstall-hooks                        # remove os hooks
node bin/kiro-office.js start --port 5000      # outra porta (exporte KIRO_OFFICE_PORT=5000 para os hooks)
npm test
```

> Os hooks apontam para o caminho absoluto deste clone. Se mover a pasta, rode `npm run install-hooks` de novo.

## Observações do MVP

- **Nomes dos gatilhos:** `SessionStart`, `PreToolUse`, `PostToolUse`, `PermissionRequest` e `SessionEnd` estão documentados. Já `UserPromptSubmit` e `Stop` seguem os nomes da CLI 2.x em PascalCase. Cada gatilho fica num arquivo separado: se a sua versão do CLI não reconhecer algum, os outros continuam funcionando. Se `/hooks` não listar algum, me avise ou ajuste o nome em `src/hooks-installer.js`.
- O servidor só escuta em `127.0.0.1` e o estado fica só em memória.
- Uma sessão sem eventos por 15 minutos sai do escritório sozinha.
- O texto do prompt (variável `USER_PROMPT`) aparece no painel lateral. Fica só na sua máquina.

## Estrutura

```
bin/kiro-office.js        CLI (start, install-hooks, uninstall-hooks, status)
hooks/send.js             script executado pelos hooks do Kiro CLI
src/events.js             normalização de eventos e categorias de ferramentas
src/store.js              estado das sessões
src/server.js             HTTP + SSE + arquivos estáticos
src/hooks-installer.js    gera os arquivos ~/.kiro/hooks/kiro-office-*.json
public/                   página do escritório (canvas)
scripts/demo.js           simulador de sessões
test/                     testes (node --test)
```

## Licença

MIT
