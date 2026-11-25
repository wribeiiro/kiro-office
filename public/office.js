// Kiro Office — renderização do escritório em canvas (pixel art desenhada em código).
(() => {
  const S = 3; // escala do pixel
  const COLS = 4;
  const SLOT_W = 80;
  const SLOT_H = 76;
  const WALL_H = 36;
  const MARGIN = 8;
  const DONE_MS = 6000; // tempo mostrando o "concluído" antes de voltar a ocioso

  const LABELS = {
    idle: 'Ocioso',
    thinking: 'Pensando',
    read: 'Lendo',
    write: 'Escrevendo',
    shell: 'Terminal',
    web: 'Na web',
    mcp: 'Usando MCP',
    delegate: 'Delegando',
    work: 'Trabalhando',
    waiting: 'Aguardando você',
    done: 'Concluído',
    leaving: 'Saindo',
  };
  const STATE_COLORS = {
    idle: '#6c7a99', thinking: '#9b6bff', read: '#e8d9a8', write: '#5fb3ff', shell: '#4fd18b',
    web: '#7fd3ff', mcp: '#ffa94d', delegate: '#3fd0c9', work: '#5fb3ff', waiting: '#ff5d6c',
    done: '#4fd18b', leaving: '#555',
  };
  const SHIRTS = ['#e0603f', '#3f8ee0', '#3fbf7f', '#c04fd6', '#e0b23f', '#3fc7d6', '#d64f7a', '#7f8c3f'];
  const HAIRS = ['#2b1d14', '#5a3a1e', '#a0522d', '#e8c26a', '#1c1c2a', '#8a8a8a', '#b23a3a'];
  const SKINS = ['#f2d0b1', '#e0b08a', '#c68b5e', '#8d5a3b', '#5e3b26'];

  const canvas = document.getElementById('office');
  const ctx = canvas.getContext('2d');
  const panel = document.getElementById('panel');
  const summary = document.getElementById('summary');
  const conn = document.getElementById('conn');
  const empty = document.getElementById('empty');

  let sessions = [];
  let clockOffset = 0; // servidor - cliente
  let selectedId = null;
  const actors = new Map(); // id -> { slot, firstSeen }
  let rows = 2;

  // ---------- utilidades ----------
  const hash = (str) => {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return h >>> 0;
  };
  const look = (id) => {
    const h = hash(id);
    return {
      shirt: SHIRTS[h % SHIRTS.length],
      hair: HAIRS[(h >>> 4) % HAIRS.length],
      skin: SKINS[(h >>> 8) % SKINS.length],
      mug: SHIRTS[(h >>> 12) % SHIRTS.length],
    };
  };
  const darken = (hex, f = 0.7) => {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.round(((n >> 16) & 255) * f);
    const g = Math.round(((n >> 8) & 255) * f);
    const b = Math.round((n & 255) * f);
    return `rgb(${r},${g},${b})`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const hhmmss = (t) => new Date(t).toLocaleTimeString('pt-BR');
  const px = (x, y, w, h, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };
  const serverNow = () => Date.now() + clockOffset;

  /** Estado visual: "done" volta a "idle" depois de alguns segundos. */
  const visualState = (s) => (s.state === 'done' && serverNow() - s.stateAt > DONE_MS ? 'idle' : s.state);

  const slotOrigin = (slot) => ({
    sx: MARGIN + (slot % COLS) * SLOT_W,
    sy: WALL_H + Math.floor(slot / COLS) * SLOT_H,
  });

  // ---------- layout ----------
  function resize() {
    const maxSlot = Math.max(-1, ...[...actors.values()].map((a) => a.slot));
    rows = Math.max(2, Math.ceil((maxSlot + 1) / COLS));
    const w = MARGIN * 2 + COLS * SLOT_W;
    const h = WALL_H + rows * SLOT_H + MARGIN;
    if (canvas.width !== w * S || canvas.height !== h * S) {
      canvas.width = w * S;
      canvas.height = h * S;
      canvas.style.width = `${w * S}px`;
      canvas.style.height = `${h * S}px`;
    }
  }

  function syncActors() {
    const ids = new Set(sessions.map((s) => s.id));
    for (const id of actors.keys()) if (!ids.has(id)) actors.delete(id);
    const used = new Set([...actors.values()].map((a) => a.slot));
    for (const s of sessions) {
      if (actors.has(s.id)) continue;
      let slot = 0;
      while (used.has(slot)) slot++;
      used.add(slot);
      actors.set(s.id, { slot, firstSeen: performance.now() });
    }
    if (selectedId && !ids.has(selectedId)) selectedId = null;
    resize();
  }

  // ---------- cenário ----------
  function drawRoom(w, h) {
    for (let y = WALL_H; y < h; y += 8) {
      for (let x = 0; x < w; x += 8) px(x, y, 8, 8, ((x + y) / 8) % 2 ? '#3b3049' : '#362c43');
    }
    px(0, 0, w, WALL_H, '#4a3f63');
    px(0, WALL_H - 3, w, 3, '#2c2540');
    for (let i = 0; i < COLS; i++) {
      const x = MARGIN + i * SLOT_W + 20;
      px(x, 6, 40, 20, '#2c2540');
      px(x + 2, 8, 17, 16, '#7fb0e0');
      px(x + 21, 8, 17, 16, '#7fb0e0');
      px(x + 4, 10, 6, 2, '#c8e2f7');
      px(x + 23, 10, 6, 2, '#c8e2f7');
    }
    // plantas nas pontas
    for (const x of [2, w - 8]) {
      px(x, WALL_H + 4, 6, 6, '#8a5a34');
      px(x - 1, WALL_H - 4, 8, 8, '#3fa36b');
      px(x + 1, WALL_H - 7, 4, 4, '#4fc27f');
    }
  }

  function drawScreen(x, y, state, t, active) {
    const w = 16;
    const h = 10;
    if (!active) return px(x, y, w, h, '#1a1a22');
    const tick = Math.floor(t / 180);
    switch (state) {
      case 'idle': {
        px(x, y, w, h, '#23304a');
        const p = Math.floor(t / 400) % (w * h);
        px(x + (p % w), y + Math.floor(p / w) % h, 1, 1, '#8fb0ff');
        break;
      }
      case 'thinking':
        px(x, y, w, h, '#2b2140');
        if (Math.floor(t / 400) % 2) px(x + 2, y + 2, 1, 3, '#d6c8ff');
        break;
      case 'read':
        px(x, y, w, h, '#e8e4d8');
        for (let i = 0; i < 4; i++) px(x + 2, y + 1 + i * 2 + ((tick >> 2) % 2), 8 + ((i * 5) % 5), 1, '#9a9488');
        break;
      case 'shell':
        px(x, y, w, h, '#0b0f0b');
        for (let i = 0; i < 4; i++) px(x + 1, y + 1 + i * 2, 3 + ((tick + i * 3) % 11), 1, '#4fd18b');
        break;
      case 'web':
        px(x, y, w, h, '#cfe6ff');
        px(x, y, w, 2, '#5f8fd0');
        px(x + 2, y + 4, 5, 4, '#5fb3ff');
        px(x + 9, y + 4, 5, 1, '#7a8aa0');
        px(x + 9, y + 6, 4, 1, '#7a8aa0');
        break;
      case 'mcp':
        px(x, y, w, h, '#3a2a14');
        for (let i = 0; i < 4; i++) px(x + 1, y + 1 + i * 2, 2 + ((tick + i * 2) % 12), 1, '#ffa94d');
        break;
      case 'delegate':
        px(x, y, w, h, '#12333a');
        px(x + 2 + (tick % 10), y + 4, 3, 2, '#3fd0c9');
        break;
      case 'waiting':
        px(x, y, w, h, Math.floor(t / 350) % 2 ? '#5a1a24' : '#2a0d12');
        px(x + 7, y + 2, 2, 4, '#ff5d6c');
        px(x + 7, y + 7, 2, 1, '#ff5d6c');
        break;
      case 'done':
        px(x, y, w, h, '#173a28');
        px(x + 5, y + 5, 2, 2, '#4fd18b');
        px(x + 7, y + 6, 2, 2, '#4fd18b');
        px(x + 9, y + 2, 2, 4, '#4fd18b');
        break;
      default: {
        // write / work: código colorido rolando
        px(x, y, w, h, '#1e1e2a');
        const colors = ['#5fb3ff', '#c792ea', '#ffcb6b', '#89ddff'];
        for (let i = 0; i < 4; i++) {
          const k = tick + i;
          px(x + 1 + (k % 3), y + 1 + i * 2, 4 + ((k * 7) % 9), 1, colors[k % colors.length]);
        }
      }
    }
  }

  function drawDesk(sx, sy, look, s, t) {
    const active = !!s;
    const state = s ? visualState(s) : null;
    px(sx + 8, sy + 30, 64, 5, '#b07a4a');
    px(sx + 8, sy + 35, 64, 2, '#8a5a34');
    px(sx + 10, sy + 37, 60, 16, '#6e4527');
    px(sx + 12, sy + 40, 56, 1, '#5c391f');
    // monitor
    px(sx + 12, sy + 16, 18, 13, '#2a2a35');
    px(sx + 19, sy + 29, 4, 1, '#2a2a35');
    drawScreen(sx + 13, sy + 17, state, t, active);
    // teclado e caneca
    px(sx + 34, sy + 31, 12, 2, active ? '#dcdce6' : '#9a9aa6');
    if (look) {
      px(sx + 60, sy + 26, 5, 4, look.mug);
      px(sx + 65, sy + 27, 1, 2, look.mug);
    }
  }

  function drawChair(sx, sy) {
    px(sx + 30, sy + 14, 20, 17, '#3a3350');
    px(sx + 31, sy + 15, 18, 2, '#4a4266');
  }

  function drawCharacter(sx, sy, s, look, t, phase) {
    const state = visualState(s);
    const cx = sx + 33;
    const slowBob = Math.floor(t / 600) % 2;
    const typing = ['write', 'work', 'shell', 'web', 'mcp', 'delegate'].includes(state);
    const bob = state === 'thinking' || state === 'idle' ? slowBob : 0;
    const cy = sy + 10 + bob;
    const dark = darken(look.shirt);
    const sinceState = serverNow() - s.stateAt;

    if (phase === 'body') {
      px(cx + 1, cy + 9, 12, 9, look.shirt);
      px(cx + 5, cy + 9, 4, 1, darken(look.shirt, 0.85));
      // cabeça
      px(cx + 2, cy + 3, 10, 6, look.skin);
      px(cx + 2, cy, 10, 3, look.hair);
      px(cx + 2, cy + 3, 1, 2, look.hair);
      px(cx + 11, cy + 3, 1, 2, look.hair);
      const blink = Math.floor((t + (hash(s.id) % 3000)) / 150) % 24 === 0;
      const eyeY = state === 'read' ? cy + 6 : cy + 5;
      const eyeH = blink || state === 'read' ? 1 : 2;
      px(cx + 4, eyeY, 2, eyeH, '#222');
      px(cx + 8, eyeY, 2, eyeH, '#222');
      if (state === 'done' && sinceState < DONE_MS) px(cx + 5, cy + 8, 4, 1, '#a0433a'); // sorriso

      // braços (parte que fica atrás da mesa)
      if (typing) {
        px(cx, cy + 13, 3, 6, dark);
        px(cx + 11, cy + 13, 3, 6, dark);
      } else if (state === 'waiting') {
        const wave = Math.floor(t / 250) % 2;
        px(cx - 1, cy + 10, 2, 7, dark);
        px(cx + 13 + wave, cy + 1, 2, 9, dark);
        px(cx + 13 + wave, cy - 1, 2, 2, look.skin);
      } else if (state === 'done' && sinceState < 1500) {
        px(cx - 1, cy + 1, 2, 9, dark);
        px(cx + 13, cy + 1, 2, 9, dark);
        px(cx - 1, cy - 1, 2, 2, look.skin);
        px(cx + 13, cy - 1, 2, 2, look.skin);
      } else if (state !== 'read') {
        px(cx - 1, cy + 10, 2, 7, dark);
        px(cx + 13, cy + 10, 2, 7, dark);
      }
      return;
    }

    // phase === 'front': mãos e objetos na frente da mesa
    if (typing) {
      const alt = Math.floor(t / 140) % 2;
      px(cx + 2, sy + 29 + (alt ? -1 : 0), 3, 2, look.skin);
      px(cx + 9, sy + 29 + (alt ? 0 : -1), 3, 2, look.skin);
    } else if (state === 'read') {
      px(cx + 3, cy + 14, 8, 7, '#f4f1e8');
      for (let i = 0; i < 3; i++) px(cx + 4, cy + 15 + i * 2, 6 - (i % 2) * 2, 1, '#a9a395');
      px(cx + 1, cy + 17, 2, 2, look.skin);
      px(cx + 11, cy + 17, 2, 2, look.skin);
    }
  }

  function drawBubble(sx, sy, s, t) {
    const state = visualState(s);
    let kind = null;
    if (state === 'thinking') kind = 'dots';
    else if (state === 'waiting') kind = 'alert';
    else if (state === 'done' && serverNow() - s.stateAt < DONE_MS) kind = 'check';
    if (!kind) return;

    const bounce = kind === 'alert' ? Math.floor(t / 200) % 2 : 0;
    const x = sx + 46;
    const y = sy - 1 - bounce;
    const border = kind === 'alert' ? '#ff5d6c' : '#2c2540';
    px(x, y, 18, 10, border);
    px(x + 1, y + 1, 16, 8, '#fdfbff');
    px(x + 2, y + 10, 3, 2, border);
    px(x + 3, y + 9, 2, 2, '#fdfbff');

    if (kind === 'dots') {
      const n = Math.floor(t / 300) % 4;
      for (let i = 0; i < 3; i++) px(x + 4 + i * 4, y + 4, 2, 2, i < n ? '#5a4a80' : '#d6d0e6');
    } else if (kind === 'alert') {
      px(x + 8, y + 2, 2, 4, '#ff5d6c');
      px(x + 8, y + 7, 2, 1, '#ff5d6c');
    } else {
      px(x + 5, y + 5, 2, 2, '#2fa86a');
      px(x + 7, y + 6, 2, 2, '#2fa86a');
      px(x + 9, y + 4, 2, 2, '#2fa86a');
      px(x + 11, y + 2, 2, 2, '#2fa86a');
    }
  }

  function drawLabel(sx, sy, s, selected) {
    const state = visualState(s);
    ctx.font = 'bold 6px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = s.name.length > 16 ? s.name.slice(0, 15) + '…' : s.name;
    const w = Math.ceil(ctx.measureText(text).width) + 8;
    const x = sx + SLOT_W / 2;
    const y = sy + 62;
    px(x - w / 2, y - 5, w, 10, selected ? '#9b6bff' : 'rgba(23,20,31,0.85)');
    px(x - w / 2, y + 5, w, 1, STATE_COLORS[state] || '#888');
    ctx.fillStyle = '#ece6f7';
    ctx.fillText(text, x, y + 0.5);
  }

  // ---------- loop ----------
  function frame(t) {
    const w = canvas.width / S;
    const h = canvas.height / S;
    ctx.setTransform(S, 0, 0, S, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    drawRoom(w, h);

    const bySlot = new Map();
    for (const s of sessions) {
      const a = actors.get(s.id);
      if (a) bySlot.set(a.slot, { s, a });
    }

    for (let slot = 0; slot < rows * COLS; slot++) {
      const { sx, sy } = slotOrigin(slot);
      const entry = bySlot.get(slot);
      drawChair(sx, sy);
      if (!entry) {
        drawDesk(sx, sy, null, null, t);
        continue;
      }
      const { s, a } = entry;
      const lk = look(s.id);
      const fadeIn = Math.min(1, (performance.now() - a.firstSeen) / 600);
      const fadeOut = s.state === 'leaving' ? Math.max(0, 1 - (serverNow() - s.stateAt) / 2500) : 1;
      ctx.globalAlpha = fadeIn * fadeOut;
      drawCharacter(sx, sy, s, lk, t, 'body');
      ctx.globalAlpha = 1;
      drawDesk(sx, sy, lk, s.state === 'leaving' ? null : s, t);
      ctx.globalAlpha = fadeIn * fadeOut;
      drawCharacter(sx, sy, s, lk, t, 'front');
      drawBubble(sx, sy, s, t);
      ctx.globalAlpha = 1;
      drawLabel(sx, sy, s, s.id === selectedId);
    }

    const waiting = sessions.some((s) => s.state === 'waiting');
    const title = waiting && Math.floor(t / 800) % 2 ? '(!) Kiro Office' : 'Kiro Office';
    if (document.title !== title) document.title = title;

    requestAnimationFrame(frame);
  }

  // ---------- painel lateral ----------
  function renderPanel() {
    const active = sessions.filter((s) => s.state !== 'leaving');
    const busy = active.filter((s) => !['idle', 'done'].includes(visualState(s))).length;
    const waiting = active.filter((s) => s.state === 'waiting').length;
    summary.textContent = `${active.length} agente(s) · ${busy} ocupado(s)${waiting ? ` · ${waiting} aguardando você` : ''}`;
    empty.classList.toggle('hidden', sessions.length > 0);

    panel.innerHTML = sessions
      .map((s) => {
        const state = visualState(s);
        const lk = look(s.id);
        const cls = ['card', s.id === selectedId ? 'selected' : '', state === 'waiting' ? 'waiting' : ''].join(' ');
        const detail = s.tool || s.detail ? `<div class="detail">${esc(s.tool)}${s.tool && s.detail ? ' · ' : ''}${esc(s.detail)}</div>` : '';
        const log = s.log
          .slice(0, 5)
          .map((l) => `<li><time>${hhmmss(l.t)}</time>${esc(l.text)}</li>`)
          .join('');
        return `<div class="${cls}" data-id="${esc(s.id)}">
          <div class="top"><span class="dot" style="background:${lk.shirt}"></span>
          <span class="name">${esc(s.name)}</span><span class="state">${LABELS[state] || state}</span></div>
          <div class="cwd">${esc(s.cwd)}</div>${detail}<ul>${log}</ul></div>`;
      })
      .join('');
  }

  panel.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    selectedId = card.dataset.id === selectedId ? null : card.dataset.id;
    renderPanel();
  });

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / S - MARGIN;
    const y = (e.clientY - rect.top) / S - WALL_H;
    if (x < 0 || y < 0) return;
    const slot = Math.floor(y / SLOT_H) * COLS + Math.floor(x / SLOT_W);
    const hit = sessions.find((s) => actors.get(s.id)?.slot === slot);
    selectedId = hit ? hit.id : null;
    renderPanel();
    if (hit) panel.querySelector(`[data-id="${CSS.escape(hit.id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  // ---------- conexão ----------
  function apply(snapshot) {
    clockOffset = snapshot.now - Date.now();
    sessions = snapshot.sessions;
    syncActors();
    renderPanel();
  }

  function connect() {
    const es = new EventSource('/api/events');
    es.onopen = () => {
      conn.textContent = 'ao vivo';
      conn.className = 'conn on';
    };
    es.onmessage = (e) => apply(JSON.parse(e.data));
    es.onerror = () => {
      conn.textContent = 'desconectado';
      conn.className = 'conn off';
    };
  }

  // atualiza o painel periodicamente (ex.: "Concluído" → "Ocioso")
  setInterval(renderPanel, 2000);

  resize();
  connect();
  requestAnimationFrame(frame);
})();
