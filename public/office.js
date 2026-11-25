// Kiro Office — escritório em canvas com fantasminhas pixel (desenhados em código).
// Agentes ocupados ficam na mesa; ociosos vão flutuando até o café.
(() => {
  // ---------- layout (unidades lógicas; cada uma vira S pixels na tela) ----------
  const COLS = 4;
  const SLOT_W = 80;
  const SLOT_H = 76;
  const WALL_H = 36;
  const MARGIN = 8;
  const GAP = 6; // pilar entre o escritório e o café
  const CAFE_W = 104;
  const OFFICE_W = MARGIN + COLS * SLOT_W;
  const CAFE_X = OFFICE_W + GAP;
  const W = CAFE_X + CAFE_W;

  const DONE_MS = 6000; // mostra o ✓ por 6 s depois do turno
  const CAFE_AFTER_MS = 3000; // ocioso por 3 s → vai para o café
  const SPEED = 55; // velocidade de voo (unidades lógicas por segundo)
  const GHOST_W = 14;

  const LABELS = {
    idle: 'Ocioso', thinking: 'Pensando', read: 'Lendo', write: 'Escrevendo', shell: 'Terminal',
    web: 'Na web', mcp: 'Usando MCP', delegate: 'Delegando', work: 'Trabalhando',
    waiting: 'Aguardando você', done: 'Concluído', leaving: 'Saindo', cafe: 'No café ☕',
  };
  const STATE_COLORS = {
    idle: '#6c7a99', thinking: '#9b6bff', read: '#e8d9a8', write: '#5fb3ff', shell: '#4fd18b',
    web: '#7fd3ff', mcp: '#ffa94d', delegate: '#3fd0c9', work: '#5fb3ff', waiting: '#ff5d6c',
    done: '#4fd18b', leaving: '#555', cafe: '#c08a5a',
  };
  const BODIES = ['#f6f3ff', '#cdb8ff', '#9be3ff', '#a8f0c6', '#ffd59e', '#ffb3c7', '#e2f59b', '#b8c7ff', '#ffc2a1'];
  const MUGS = ['#e0603f', '#3f8ee0', '#3fbf7f', '#c04fd6', '#e0b23f', '#3fc7d6', '#d64f7a'];
  const EYE = '#2b2140';

  // Fantasminha 14×11 + barra ondulada animada (2 quadros).
  const GHOST = [
    '....######....',
    '..##########..',
    '.############.',
    '.############.',
    '##############',
    '##############',
    '##############',
    '##############',
    '##############',
    '##############',
    '##############',
  ];
  const HEMS = [
    ['###.####.####.', '.#....#....##.'],
    ['.####.####.###', '.##....#....#.'],
  ];
  const toRuns = (row) => {
    const runs = [];
    let start = -1;
    for (let i = 0; i <= row.length; i++) {
      if (row[i] === '#' && start < 0) start = i;
      if (row[i] !== '#' && start >= 0) {
        runs.push([start, i - start]);
        start = -1;
      }
    }
    return runs;
  };
  const GHOST_FRAMES = HEMS.map((hem) => [...GHOST, ...hem].map(toRuns));

  // Filhote (subagente) 8×8
  const MINI = ['..####..', '.######.', '########', '########', '########', '########'];
  const MINI_HEMS = ['##.##.##', '#.##.##.'];
  const MINI_FRAMES = MINI_HEMS.map((hem) => [...MINI, hem].map(toRuns));
  const MINI_W = 8;
  const PLANE_MS = 900;

  // ---------- DOM ----------
  const canvas = document.getElementById('office');
  const ctx = canvas.getContext('2d');
  const panel = document.getElementById('panel');
  const summary = document.getElementById('summary');
  const conn = document.getElementById('conn');
  const empty = document.getElementById('empty');

  let S = 3;
  let H = 0;
  let rows = 2;
  let sessions = [];
  let clockOffset = 0;
  let selectedId = null;
  let lastT = performance.now();
  const actors = new Map(); // id -> { slot, x, y, spot, firstSeen } | { kid, parentId, x, y, firstSeen }
  let planes = []; // aviõezinhos de papel: { from, to, start }

  // ---------- utilidades ----------
  const hash = (str) => {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return h >>> 0;
  };
  // cor do fantasma pela mesa (cores diferentes entre vizinhos); caneca e fase pelo id
  const look = (id) => {
    const h = hash(id);
    const a = actors.get(id);
    const slot = (a?.kid ? actors.get(a.parentId)?.slot : a?.slot) ?? h;
    return { body: BODIES[slot % BODIES.length], mug: MUGS[(h >>> 8) % MUGS.length], phase: (h % 1000) / 160 };
  };
  const darken = (hex, f = 0.6) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${Math.round(((n >> 16) & 255) * f)},${Math.round(((n >> 8) & 255) * f)},${Math.round((n & 255) * f)})`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const hhmmss = (t) => new Date(t).toLocaleTimeString('pt-BR');
  const px = (x, y, w, h, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  };
  const serverNow = () => Date.now() + clockOffset;

  const visualState = (s) => (s.state === 'done' && serverNow() - s.stateAt > DONE_MS ? 'idle' : s.state);
  const idleSince = (s) => (s.state === 'idle' ? s.stateAt : s.state === 'done' ? s.stateAt + DONE_MS : null);
  const wantsCafe = (s) => {
    const since = idleSince(s);
    return since != null && serverNow() - since > CAFE_AFTER_MS;
  };

  const slotOrigin = (slot) => ({ sx: MARGIN + (slot % COLS) * SLOT_W, sy: WALL_H + Math.floor(slot / COLS) * SLOT_H });
  const seatPos = (slot) => {
    const { sx, sy } = slotOrigin(slot);
    return { x: sx + 33, y: sy + 14 };
  };
  const DOOR = { x: CAFE_X + CAFE_W - 22, y: WALL_H - 10 };

  const byId = (id) => sessions.find((s) => s.id === id);
  const isKid = (s) => !!s.parentId && !!byId(s.parentId);
  const topLevel = () => sessions.filter((s) => !isKid(s));
  const kidsOf = (id) => sessions.filter((s) => s.parentId === id);
  /** Lugar do filhote: no chão, na frente da mesa do pai. */
  const kidSpot = (parentSlot, i) => {
    const { sx, sy } = slotOrigin(parentSlot);
    return { x: sx + 6 + (i % 6) * 12, y: sy + 55 + Math.floor(i / 6) * 3 };
  };

  /** Mesas do café e os lugares (um de cada lado). */
  function cafeLayout() {
    const tables = [];
    for (let ty = WALL_H + 32; ty < H - 14; ty += 36) tables.push({ x: CAFE_X + 52, y: ty });
    const spots = [];
    for (const t of tables) {
      spots.push({ x: t.x - 22, y: t.y - 10, side: 'left' });
      spots.push({ x: t.x + 8, y: t.y - 10, side: 'right' });
    }
    return { tables, spots };
  }

  // ---------- tamanho e escala ----------
  function resize() {
    const maxSlot = Math.max(-1, ...[...actors.values()].filter((a) => !a.kid).map((a) => a.slot));
    rows = Math.max(2, Math.ceil((maxSlot + 1) / COLS));
    H = WALL_H + rows * SLOT_H + MARGIN;
    S = Math.max(1, Math.min(3, Math.floor((window.innerWidth - 380) / W)));
    if (canvas.width !== W * S || canvas.height !== H * S) {
      canvas.width = W * S;
      canvas.height = H * S;
      canvas.style.width = `${W * S}px`;
      canvas.style.height = `${H * S}px`;
    }
  }
  window.addEventListener('resize', resize);

  function syncActors() {
    const ids = new Set(sessions.map((s) => s.id));
    for (const id of actors.keys()) if (!ids.has(id)) actors.delete(id);
    const used = new Set([...actors.values()].filter((a) => !a.kid).map((a) => a.slot));
    for (const s of topLevel()) {
      if (actors.has(s.id)) continue;
      let slot = 0;
      while (used.has(slot)) slot++;
      used.add(slot);
      actors.set(s.id, { slot, x: DOOR.x, y: DOOR.y, spot: -1, firstSeen: performance.now() });
    }
    // filhotes nascem do pai, com um aviãozinho de papel levando a tarefa
    for (const s of sessions.filter(isKid)) {
      if (actors.has(s.id)) continue;
      const p = actors.get(s.parentId);
      if (!p) continue;
      const i = kidsOf(s.parentId).indexOf(s);
      const from = { x: p.x + 4, y: p.y + 4 };
      actors.set(s.id, { kid: true, parentId: s.parentId, x: from.x, y: from.y, firstSeen: performance.now() });
      planes.push({ from: { x: p.x + 7, y: p.y + 2 }, to: kidSpot(p.slot, i), start: performance.now() });
    }
    if (selectedId && !ids.has(selectedId)) selectedId = null;
    resize();
  }

  // ---------- movimento ----------
  function updateActors(dt) {
    const { spots } = cafeLayout();
    const taken = new Set([...actors.values()].map((a) => a.spot).filter((i) => i >= 0));
    for (const s of sessions) {
      const a = actors.get(s.id);
      if (!a || a.kid) continue;
      let target;
      if (s.state === 'leaving') {
        target = DOOR;
        a.spot = -1;
      } else if (wantsCafe(s)) {
        if (a.spot < 0) {
          let i = 0;
          while (taken.has(i) && i < spots.length) i++;
          a.spot = i < spots.length ? i : taken.size % Math.max(1, spots.length);
          taken.add(a.spot);
        }
        target = spots[a.spot] ?? DOOR;
      } else {
        if (a.spot >= 0) taken.delete(a.spot);
        a.spot = -1;
        target = seatPos(a.slot);
      }
      const dx = target.x - a.x;
      const dy = target.y - a.y;
      const dist = Math.hypot(dx, dy);
      const step = SPEED * dt;
      if (dist <= step) {
        a.x = target.x;
        a.y = target.y;
      } else {
        a.x += (dx / dist) * step;
        a.y += (dy / dist) * step;
      }
      const seat = seatPos(a.slot);
      a.seated = a.spot < 0 && s.state !== 'leaving' && a.x === seat.x && a.y === seat.y;
      a.inCafe = a.spot >= 0 && a.x === target.x && a.y === target.y;
      a.side = target.side;
    }

    // filhotes: ficam na frente da mesa do pai; ao terminar, voam até ele para entregar o resultado
    for (const p of topLevel()) {
      const pa = actors.get(p.id);
      if (!pa) continue;
      kidsOf(p.id).forEach((k, i) => {
        const a = actors.get(k.id);
        if (!a) return;
        const target = k.state === 'leaving' ? { x: pa.x + 3, y: pa.y + 6 } : kidSpot(pa.slot, i);
        moveTowards(a, target, SPEED * 1.3 * dt);
        a.arrived = a.x === target.x && a.y === target.y;
      });
    }
    planes = planes.filter((pl) => performance.now() - pl.start < PLANE_MS);
  }

  function moveTowards(a, target, step) {
    const dx = target.x - a.x;
    const dy = target.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= step) {
      a.x = target.x;
      a.y = target.y;
    } else {
      a.x += (dx / dist) * step;
      a.y += (dy / dist) * step;
    }
  }

  // ---------- desenho: fantasma ----------
  function drawGhost(x, y, lk, t, { eyes = 'normal', mouth = false } = {}) {
    const frame = GHOST_FRAMES[Math.floor(t / 300 + lk.phase) % 2];
    const outline = darken(lk.body, 0.55);
    frame.forEach((runs, r) => runs.forEach(([c, len]) => px(x + c - 1, y + r - 1, len + 2, 3, outline)));
    frame.forEach((runs, r) => runs.forEach(([c, len]) => px(x + c, y + r, len, 1, lk.body)));
    px(x + 3, y + 2, 3, 1, 'rgba(255,255,255,0.7)');
    px(x + 11, y + 5, 1, 6, darken(lk.body, 0.88));

    const blink = Math.floor(t / 150 + lk.phase * 7) % 26 === 0;
    if (eyes === 'happy') {
      px(x + 3, y + 5, 1, 1, EYE); px(x + 4, y + 4, 1, 1, EYE); px(x + 5, y + 5, 1, 1, EYE);
      px(x + 8, y + 5, 1, 1, EYE); px(x + 9, y + 4, 1, 1, EYE); px(x + 10, y + 5, 1, 1, EYE);
    } else if (eyes === 'down' || blink) {
      px(x + 3, y + 6, 2, 1, EYE);
      px(x + 9, y + 6, 2, 1, EYE);
    } else {
      px(x + 3, y + 4, 2, 3, EYE);
      px(x + 9, y + 4, 2, 3, EYE);
      px(x + 3, y + 4, 1, 1, '#ffffff');
      px(x + 9, y + 4, 1, 1, '#ffffff');
    }
    px(x + 1, y + 7, 2, 1, '#ff9fb8');
    px(x + 11, y + 7, 2, 1, '#ff9fb8');
    if (mouth) px(x + 6, y + 8, 2, 1, EYE);
  }

  function nub(x, y, lk) {
    px(x - 1, y - 1, 4, 4, darken(lk.body, 0.55));
    px(x, y, 2, 2, lk.body);
  }

  function drawMug(x, y, color, t) {
    px(x, y, 4, 4, color);
    px(x + 4, y + 1, 1, 2, color);
    px(x, y, 4, 1, '#5a3a22');
    const k = Math.floor(t / 250) % 3;
    px(x + 1, y - 2 - k, 1, 1, 'rgba(255,255,255,0.7)');
    px(x + 2, y - 4 - ((k + 1) % 3), 1, 1, 'rgba(255,255,255,0.5)');
  }

  // ---------- desenho: cenário ----------
  function drawRoom(t) {
    // piso do escritório (xadrez) e do café (tábuas de madeira)
    for (let y = WALL_H; y < H; y += 8) {
      for (let x = 0; x < OFFICE_W; x += 8) px(x, y, 8, 8, ((x + y) / 8) % 2 ? '#3b3049' : '#362c43');
    }
    for (let y = WALL_H, i = 0; y < H; y += 5, i++) {
      px(CAFE_X, y, CAFE_W, 5, i % 2 ? '#7a5236' : '#6e4a30');
      px(CAFE_X + ((i * 23) % CAFE_W), y, 1, 5, '#5c3d27');
    }
    px(OFFICE_W, WALL_H, GAP, H - WALL_H, '#2c2540');

    // paredes
    px(0, 0, OFFICE_W, WALL_H, '#4a3f63');
    px(CAFE_X, 0, CAFE_W, WALL_H, '#5e4552');
    px(OFFICE_W, 0, GAP, WALL_H, '#2c2540');
    px(0, WALL_H - 3, W, 3, '#2c2540');
    for (let i = 0; i < COLS; i++) {
      const x = MARGIN + i * SLOT_W + 20;
      px(x, 6, 40, 20, '#2c2540');
      px(x + 2, 8, 17, 16, '#7fb0e0');
      px(x + 21, 8, 17, 16, '#7fb0e0');
      px(x + 4, 10, 6, 2, '#c8e2f7');
      px(x + 23, 10, 6, 2, '#c8e2f7');
    }
    // planta no canto do escritório
    px(2, WALL_H + 4, 6, 6, '#8a5a34');
    px(1, WALL_H - 4, 8, 8, '#3fa36b');
    px(3, WALL_H - 7, 4, 4, '#4fc27f');

    // café: placa, prateleira de xícaras, porta
    px(CAFE_X + 30, 5, 34, 13, '#2d4a3a');
    px(CAFE_X + 30, 5, 34, 1, '#8a5a34');
    ctx.font = 'bold 7px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f3ead2';
    ctx.fillText('CAFÉ', CAFE_X + 47, 12);
    px(CAFE_X + 30, 22, 34, 1, '#8a5a34');
    MUGS.slice(0, 5).forEach((c, i) => px(CAFE_X + 33 + i * 6, 19, 3, 3, c));
    px(DOOR.x - 1, 8, 18, WALL_H - 8, '#3a2830');
    px(DOOR.x + 1, 10, 14, WALL_H - 10, '#8a5a34');
    px(DOOR.x + 11, 22, 2, 2, '#e0b23f');

    // balcão com máquina de café
    px(CAFE_X + 2, WALL_H - 1, 26, 3, '#c9c2b8');
    px(CAFE_X + 2, WALL_H + 2, 26, 10, '#8a5a34');
    px(CAFE_X + 4, WALL_H + 4, 22, 1, '#6e4527');
    px(CAFE_X + 6, WALL_H - 14, 14, 13, '#3a3a44');
    px(CAFE_X + 6, WALL_H - 14, 14, 2, '#55556a');
    px(CAFE_X + 17, WALL_H - 10, 1, 1, Math.floor(t / 600) % 2 ? '#ff5d6c' : '#7a2a34');
    px(CAFE_X + 11, WALL_H - 6, 4, 2, '#22222a');
    px(CAFE_X + 11, WALL_H - 3, 4, 2, '#f3ead2');
    const k = Math.floor(t / 220) % 3;
    px(CAFE_X + 12, WALL_H - 18 - k, 1, 1, 'rgba(255,255,255,0.6)');
    px(CAFE_X + 14, WALL_H - 20 - ((k + 1) % 3), 1, 1, 'rgba(255,255,255,0.4)');
    // planta do café
    px(CAFE_X + CAFE_W - 8, H - 16, 6, 6, '#8a5a34');
    px(CAFE_X + CAFE_W - 9, H - 23, 8, 8, '#3fa36b');

    // mesinhas redondas
    for (const tb of cafeLayout().tables) {
      px(tb.x - 1, tb.y + 4, 2, 7, '#5c4636');
      px(tb.x - 4, tb.y + 10, 8, 1, '#5c4636');
      px(tb.x - 7, tb.y - 1, 14, 1, '#e6ddd0');
      px(tb.x - 8, tb.y, 16, 3, '#d9cfc2');
      px(tb.x - 7, tb.y + 3, 14, 1, '#b8ad9f');
    }
  }

  function drawScreen(x, y, state, t, active) {
    const w = 16;
    const h = 10;
    if (!active) return px(x, y, w, h, '#1a1a22');
    const tick = Math.floor(t / 180);
    switch (state) {
      case 'idle':
      case 'cafe': {
        px(x, y, w, h, '#23304a');
        const p = Math.floor(t / 400) % (w * h);
        px(x + (p % w), y + (Math.floor(p / w) % h), 1, 1, '#8fb0ff');
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
        px(x, y, w, h, '#1e1e2a');
        const colors = ['#5fb3ff', '#c792ea', '#ffcb6b', '#89ddff'];
        for (let i = 0; i < 4; i++) {
          const k = tick + i;
          px(x + 1 + (k % 3), y + 1 + i * 2, 4 + ((k * 7) % 9), 1, colors[k % colors.length]);
        }
      }
    }
  }

  function drawChair(sx, sy) {
    px(sx + 30, sy + 14, 20, 17, '#3a3350');
    px(sx + 31, sy + 15, 18, 2, '#4a4266');
  }

  /** Plaquinha dourada na frente da mesa com o nome do agente. */
  function drawNameplate(cx, cy, text) {
    ctx.font = 'bold 5px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let label = text;
    while (label.length > 4 && ctx.measureText(label).width > 52) label = label.slice(0, -2) + '…';
    const w = Math.ceil(ctx.measureText(label).width) + 8;
    const x = Math.round(cx - w / 2);
    px(x - 1, cy - 5, w + 2, 10, '#5c391f');
    px(x, cy - 4, w, 8, '#d9b56a');
    px(x, cy - 4, w, 1, '#f0d898');
    px(x + 1, cy - 2, 1, 1, '#8a6a2a');
    px(x + w - 2, cy - 2, 1, 1, '#8a6a2a');
    ctx.fillStyle = '#3a2410';
    ctx.fillText(label, Math.round(cx), cy + 0.5);
  }

  function drawDesk(sx, sy, s, lk, t, away) {
    const state = s ? (away ? 'cafe' : visualState(s)) : null;
    px(sx + 8, sy + 30, 64, 5, '#b07a4a');
    px(sx + 8, sy + 35, 64, 2, '#8a5a34');
    px(sx + 10, sy + 37, 60, 16, '#6e4527');
    px(sx + 12, sy + 40, 56, 1, '#5c391f');
    px(sx + 12, sy + 16, 18, 13, '#2a2a35');
    px(sx + 19, sy + 29, 4, 1, '#2a2a35');
    drawScreen(sx + 13, sy + 17, state, t, !!s && s.state !== 'leaving');
    px(sx + 34, sy + 31, 12, 2, s ? '#dcdce6' : '#9a9aa6');
    if (lk && !away) {
      px(sx + 60, sy + 26, 5, 4, lk.mug);
      px(sx + 65, sy + 27, 1, 2, lk.mug);
    }
  }

  const base = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);

  /** Texto curto da ação atual, mostrado no balão. */
  function actionText(s, t) {
    const d = s.detail || '';
    const tool = s.tool || '';
    switch (visualState(s)) {
      case 'thinking':
        return 'pensando' + '.'.repeat(1 + (Math.floor(t / 400) % 3));
      case 'read':
        return /(grep|search|glob|find)/i.test(tool) ? `buscando ${d || tool}` : `lendo ${base(d) || tool}`;
      case 'write':
        return `editando ${base(d) || tool}`;
      case 'shell':
        return `$ ${d || tool}`;
      case 'web':
        try {
          return `web ${new URL(d).host}`;
        } catch {
          return `web ${d || tool}`;
        }
      case 'mcp':
        return `mcp ${tool.replace(/^mcp_/, '').replace('_', ':')}`;
      case 'delegate': {
        const open = kidsOf(s.id).filter((k) => k.state !== 'leaving');
        if (open.length === 1) {
          const kidText = actionText(open[0], t);
          const who = open[0].agent || open[0].name;
          return kidText ? `↳ ${kidText}` : `delegando → ${who}`;
        }
        return open.length ? `delegando → ${open.length} sub` : 'delegando…';
      }
      case 'work':
        return tool || 'trabalhando';
      case 'waiting':
        return `permitir? ${d || tool}`;
      case 'done':
        return serverNow() - s.stateAt < DONE_MS ? 'pronto! ✓' : null;
      default:
        return null;
    }
  }

  /** Balão de fala com a ação. (cx, top) = centro do fantasma e topo da cabeça. */
  function drawBubble(cx, top, s, t, minX = 1, maxX = W - 1) {
    const text = actionText(s, t);
    if (!text) return;
    const state = visualState(s);
    const alert = state === 'waiting';
    ctx.font = '5px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let label = text;
    const maxText = Math.min(68, maxX - minX - 10);
    while (label.length > 4 && ctx.measureText(label).width > maxText) label = label.slice(0, -2) + '…';
    const w = Math.ceil(ctx.measureText(label).width) + 9;
    const h = 9;
    const bx = Math.round(Math.max(minX, Math.min(maxX - w, cx - w / 2)));
    const by = Math.round(top - h - 4 - (alert ? Math.floor(t / 200) % 2 : 0));
    const border = alert ? '#ff5d6c' : '#2c2540';
    px(bx, by, w, h, border);
    px(bx + 1, by + 1, w - 2, h - 2, alert ? '#fff0f2' : '#fdfbff');
    const tail = Math.max(bx + 2, Math.min(bx + w - 5, Math.round(cx) - 1));
    px(tail, by + h, 3, 2, border);
    px(tail + 1, by + h - 1, 1, 2, alert ? '#fff0f2' : '#fdfbff');
    px(bx + 2, by + 3, 3, 3, STATE_COLORS[state] || '#888');
    ctx.fillStyle = alert ? '#b3202f' : '#2b2140';
    ctx.fillText(label, bx + 6, by + h / 2 + 0.5);
  }

  /** Filhote (subagente), na cor do pai. */
  function drawMiniGhost(x, y, lk, t, s) {
    const frame = MINI_FRAMES[Math.floor(t / 250 + lk.phase) % 2];
    const outline = darken(lk.body, 0.55);
    frame.forEach((runs, r) => runs.forEach(([c, len]) => px(x + c - 1, y + r - 1, len + 2, 3, outline)));
    frame.forEach((runs, r) => runs.forEach(([c, len]) => px(x + c, y + r, len, 1, lk.body)));
    const state = visualState(s);
    if (state === 'done' || state === 'leaving') {
      px(x + 1, y + 3, 2, 1, EYE);
      px(x + 5, y + 3, 2, 1, EYE);
    } else {
      px(x + 2, y + 2, 1, 2, EYE);
      px(x + 5, y + 2, 1, 2, EYE);
    }
    // indicador de estado acima da cabeça
    const busy = !['idle', 'done', 'leaving'].includes(state);
    if (state === 'waiting') {
      px(x + 3, y - 7 - (Math.floor(t / 200) % 2), 2, 3, '#ff5d6c');
      px(x + 3, y - 3 - (Math.floor(t / 200) % 2), 2, 1, '#ff5d6c');
    } else if (busy) {
      px(x + 3, y - 4, 2, 2, STATE_COLORS[state] || '#888');
    }
    // carregando o resultado de volta para o pai
    if (state === 'leaving') {
      px(x + 6, y + 2, 5, 6, '#f4f1e8');
      px(x + 7, y + 3, 3, 1, '#a9a395');
      px(x + 7, y + 5, 3, 1, '#a9a395');
    }
  }

  function drawPlane(pl, now) {
    const k = Math.min(1, (now - pl.start) / PLANE_MS);
    const x = pl.from.x + (pl.to.x - pl.from.x) * k;
    const y = pl.from.y + (pl.to.y - pl.from.y) * k - Math.sin(k * Math.PI) * 14;
    px(x, y, 5, 1, '#ffffff');
    px(x + 1, y + 1, 3, 1, '#e6e0f0');
    px(x + 2, y + 2, 1, 1, '#c9c2d8');
  }

  function drawTether(a, kid) {
    const x0 = a.x + GHOST_W / 2;
    const y0 = a.y + 12;
    const x1 = kid.x + MINI_W / 2;
    const y1 = kid.y;
    const n = Math.floor(Math.hypot(x1 - x0, y1 - y0) / 3);
    for (let i = 1; i < n; i++) px(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, 1, 1, 'rgba(155,107,255,0.55)');
  }

  function drawLabel(cx, y, text, color, selected, size = 6) {
    ctx.font = `bold ${size}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = text.length > 16 ? text.slice(0, 15) + '…' : text;
    const w = Math.ceil(ctx.measureText(label).width) + 6;
    px(cx - w / 2, y - size / 2 - 2, w, size + 4, selected ? '#9b6bff' : 'rgba(23,20,31,0.85)');
    px(cx - w / 2, y + size / 2 + 2, w, 1, color);
    ctx.fillStyle = '#ece6f7';
    ctx.fillText(label, Math.round(cx), Math.round(y) + 0.5);
  }

  const panelState = (s) => {
    const a = actors.get(s.id);
    return a?.inCafe && s.state !== 'leaving' ? 'cafe' : visualState(s);
  };

  /** Fantasma sentado à mesa: corpo (atrás da mesa). */
  function drawSeatedBody(a, s, lk, t) {
    const state = visualState(s);
    const bob = state === 'thinking' || state === 'idle' ? Math.round(Math.sin(t / 450 + lk.phase)) : 0;
    const gx = a.x;
    const gy = a.y + bob;
    const done = state === 'done';
    drawGhost(gx, gy, lk, t, { eyes: done ? 'happy' : state === 'read' ? 'down' : 'normal', mouth: done });
    if (state === 'waiting') {
      const wave = Math.floor(t / 250) % 2;
      nub(gx + 15 + wave, gy + 1, lk);
    } else if (done && serverNow() - s.stateAt < 1500) {
      nub(gx - 3, gy + 1, lk);
      nub(gx + 15, gy + 1, lk);
    }
    return gy;
  }

  /** Itens na frente da mesa: "mãozinhas" digitando ou papel. */
  function drawSeatedFront(a, s, lk, t, sy) {
    const state = visualState(s);
    if (['write', 'work', 'shell', 'web', 'mcp', 'delegate'].includes(state)) {
      const alt = Math.floor(t / 140) % 2;
      nub(a.x + 2, sy + 29 - alt, lk);
      nub(a.x + 10, sy + 28 + alt, lk);
    } else if (state === 'read') {
      px(a.x + 3, a.y + 13, 8, 7, '#f4f1e8');
      for (let i = 0; i < 3; i++) px(a.x + 4, a.y + 14 + i * 2, 6 - (i % 2) * 2, 1, '#a9a395');
      nub(a.x + 1, a.y + 16, lk);
      nub(a.x + 11, a.y + 16, lk);
    }
  }

  // ---------- loop ----------
  function frame(t) {
    const dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    updateActors(dt);

    ctx.setTransform(S, 0, 0, S, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    drawRoom(t);

    const bySlot = new Map();
    for (const s of topLevel()) {
      const a = actors.get(s.id);
      if (a) bySlot.set(a.slot, { s, a });
    }

    // mesas (com quem está sentado)
    for (let slot = 0; slot < rows * COLS; slot++) {
      const { sx, sy } = slotOrigin(slot);
      const entry = bySlot.get(slot);
      drawChair(sx, sy);
      if (!entry) {
        drawDesk(sx, sy, null, null, t, false);
        continue;
      }
      const { s, a } = entry;
      const lk = look(s.id);
      let gy = a.y;
      if (a.seated) gy = drawSeatedBody(a, s, lk, t);
      drawDesk(sx, sy, s, lk, t, !a.seated);
      if (s.agent) drawNameplate(sx + SLOT_W / 2, sy + 45, s.agent);
      if (a.seated) drawSeatedFront(a, s, lk, t, sy);
      drawLabel(sx + SLOT_W / 2, sy + 70, s.name, STATE_COLORS[panelState(s)] || '#888', s.id === selectedId);
    }

    // subagentes: linha até o pai, filhotes na frente da mesa e aviõezinhos
    const now = performance.now();
    for (const s of sessions.filter(isKid)) {
      const a = actors.get(s.id);
      const pa = actors.get(s.parentId);
      if (!a || !pa) continue;
      const lk = look(s.id);
      if (s.state !== 'leaving' && pa.seated && a.arrived) drawTether(pa, a);
      const fadeIn = Math.min(1, (now - a.firstSeen) / 500);
      const fadeOut = s.state === 'leaving' && a.arrived ? Math.max(0, 1 - (serverNow() - s.stateAt) / 1200) : 1;
      ctx.globalAlpha = fadeIn * fadeOut;
      drawMiniGhost(a.x, a.y + Math.round(Math.sin(t / 300 + lk.phase)), lk, t, s);
      ctx.globalAlpha = 1;
    }
    for (const pl of planes) drawPlane(pl, now);

    // balões dos que estão sentados (depois dos filhotes, para ficarem por cima)
    for (const [slot, { s, a }] of bySlot) {
      if (!a.seated) continue;
      const { sx } = slotOrigin(slot);
      const bob = ['thinking', 'idle'].includes(visualState(s)) ? Math.round(Math.sin(t / 450 + look(s.id).phase)) : 0;
      drawBubble(a.x + GHOST_W / 2, a.y + bob, s, t, sx + 1, sx + SLOT_W - 1);
    }

    // fantasmas voando ou no café (por cima de tudo, ordenados por y)
    const floating = topLevel()
      .map((s) => ({ s, a: actors.get(s.id) }))
      .filter(({ a }) => a && !a.seated)
      .sort((p, q) => p.a.y - q.a.y);
    for (const { s, a } of floating) {
      const lk = look(s.id);
      const fadeIn = Math.min(1, (performance.now() - a.firstSeen) / 600);
      const atDoor = Math.hypot(a.x - DOOR.x, a.y - DOOR.y) < 2;
      const fadeOut = s.state === 'leaving' && atDoor ? Math.max(0, 1 - (serverNow() - s.stateAt) / 2500) : 1;
      const gy = a.y + Math.round(Math.sin(t / 380 + lk.phase) * 1.5);
      ctx.globalAlpha = fadeIn * fadeOut * (a.inCafe ? 1 : 0.85);
      drawGhost(a.x, gy, lk, t, { eyes: a.inCafe ? 'happy' : 'normal', mouth: a.inCafe });
      if (a.inCafe) {
        const mx = a.side === 'right' ? a.x - 5 : a.x + GHOST_W + 1;
        drawMug(mx, gy + 7, lk.mug, t);
      } else if (s.state !== 'leaving') {
        drawBubble(a.x + GHOST_W / 2, gy, s, t);
      }
      ctx.globalAlpha = 1;
      if (a.inCafe) drawLabel(a.x + GHOST_W / 2, gy - 6, s.name, STATE_COLORS.cafe, s.id === selectedId, 5);
    }

    const waiting = sessions.some((s) => s.state === 'waiting');
    const title = waiting && Math.floor(t / 800) % 2 ? '(!) Kiro Office' : 'Kiro Office';
    if (document.title !== title) document.title = title;

    requestAnimationFrame(frame);
  }

  // ---------- painel lateral ----------
  function renderPanel() {
    const tops = topLevel();
    const active = tops.filter((s) => s.state !== 'leaving');
    const states = active.map(panelState);
    const busy = states.filter((st) => !['idle', 'done', 'cafe'].includes(st)).length;
    const cafe = states.filter((st) => st === 'cafe').length;
    const waiting = sessions.filter((s) => s.state === 'waiting').length;
    const subs = sessions.filter((s) => isKid(s) && s.state !== 'leaving').length;
    summary.textContent =
      `${active.length} agente(s) · ${busy} ocupado(s)` +
      (subs ? ` · ${subs} subagente(s)` : '') +
      (cafe ? ` · ${cafe} no café` : '') +
      (waiting ? ` · ${waiting} aguardando você` : '');
    empty.classList.toggle('hidden', sessions.length > 0);

    const detailOf = (s) => (s.tool || s.detail ? `${esc(s.tool)}${s.tool && s.detail ? ' · ' : ''}${esc(s.detail)}` : '');
    panel.innerHTML = tops
      .map((s) => {
        const state = panelState(s);
        const lk = look(s.id);
        const kids = kidsOf(s.id);
        const kidWaiting = kids.some((k) => k.state === 'waiting');
        const cls = ['card', s.id === selectedId ? 'selected' : '', state === 'waiting' || kidWaiting ? 'waiting' : ''].join(' ');
        const detail = detailOf(s) ? `<div class="detail">${detailOf(s)}</div>` : '';
        const kidsHtml = kids.length
          ? `<div class="kids">${kids
              .map((k) => {
                const ks = visualState(k);
                const label = k.state === 'leaving' ? 'Entregando resultado' : LABELS[ks] || ks;
                return `<div class="kid${ks === 'waiting' ? ' waiting' : ''}" data-id="${esc(k.id)}"><span class="dot" style="background:${lk.body}"></span>
                  <b>${esc(k.name)}</b>${k.agent ? ` <span class="agent">${esc(k.agent)}</span>` : ''} <span class="kstate">${esc(label)}</span>${detailOf(k) ? `<div class="kdetail">${detailOf(k)}</div>` : ''}</div>`;
              })
              .join('')}</div>`
          : '';
        const log = s.log.slice(0, 5).map((l) => `<li><time>${hhmmss(l.t)}</time>${esc(l.text)}</li>`).join('');
        return `<div class="${cls}" data-id="${esc(s.id)}">
          <div class="top"><span class="dot" style="background:${lk.body}"></span>
          <span class="name">${esc(s.name)}</span>${s.agent ? `<span class="agent">${esc(s.agent)}</span>` : ''}<span class="state">${LABELS[state] || state}</span></div>
          <div class="cwd">${esc(s.cwd)}</div>${detail}${kidsHtml}<ul>${log}</ul></div>`;
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
    const x = (e.clientX - rect.left) / S;
    const y = (e.clientY - rect.top) / S;
    // primeiro os fantasmas (onde quer que estejam), depois as mesas
    let hit = sessions.find((s) => {
      const a = actors.get(s.id);
      return a && x >= a.x - 2 && x <= a.x + GHOST_W + 2 && y >= a.y - 4 && y <= a.y + 16;
    });
    if (!hit && x >= MARGIN && x < OFFICE_W && y >= WALL_H) {
      const slot = Math.floor((y - WALL_H) / SLOT_H) * COLS + Math.floor((x - MARGIN) / SLOT_W);
      hit = sessions.find((s) => actors.get(s.id)?.slot === slot);
    }
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

  setInterval(renderPanel, 1000);
  resize();
  connect();
  requestAnimationFrame(frame);
})();
