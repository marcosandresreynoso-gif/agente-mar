// app.js — Lógica del widget de chat
const MODULOS = [
  { id: 'todos', nombre: 'Todos', gl: '⬡' },
  { id: 'comercial', nombre: 'Comercial', gl: '◈' },
  { id: 'contable', nombre: 'Contable', gl: '◉' },
  { id: 'finanzas', nombre: 'Finanzas', gl: '◆' },
  { id: 'legal', nombre: 'Legal', gl: '◎' }
];

const SUGERENCIAS = {
  todos: ['¿Cómo consigo mis primeros clientes?', '¿Cómo me inscribo en AFIP?', '¿Cómo organizo mis finanzas?', '¿Necesito un contrato para mis clientes?'],
  comercial: ['¿Cómo consigo mis primeros clientes?', '¿Cómo armo mi propuesta de valor?', '¿Cómo precio mis servicios?'],
  contable: ['¿Cómo me inscribo en AFIP?', '¿Qué categoría de monotributo me corresponde?', '¿Cómo facturo?'],
  finanzas: ['¿Cómo organizo mis finanzas?', '¿Cómo calculo mis costos?', '¿Cómo proyecto mi flujo de caja?'],
  legal: ['¿Necesito un contrato para mis clientes?', '¿Cómo protejo mi trabajo intelectual?', '¿Qué forma jurídica me conviene?']
};

let moduloActivo = 'todos';
const history = [];

// Session id (persistente durante la pestaña)
let sessionId = sessionStorage.getItem('mar_sid');
if (!sessionId) {
  sessionId = 'web_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionStorage.setItem('mar_sid', sessionId);
}

const $ = (id) => document.getElementById(id);
const chat = $('chat');

/* ---- Módulos ---- */
function renderModules() {
  const c = $('modules');
  c.innerHTML = '';
  MODULOS.forEach((m) => {
    const el = document.createElement('div');
    el.className = 'mod' + (m.id === moduloActivo ? ' active' : '');
    el.innerHTML = `<span class="gl">${m.gl}</span>${m.nombre}`;
    el.onclick = () => { moduloActivo = m.id; renderModules(); renderSuggest(); };
    c.appendChild(el);
  });
}

function renderSuggest() {
  const chips = $('chips');
  chips.innerHTML = '';
  (SUGERENCIAS[moduloActivo] || SUGERENCIAS.todos).forEach((q) => {
    const el = document.createElement('div');
    el.className = 'chip';
    el.textContent = q;
    el.onclick = () => { $('input').value = q; send(); };
    chips.appendChild(el);
  });
}

/* ---- Mensajes ---- */
function addMsg(role, text) {
  const sg = $('suggest'); if (sg) sg.style.display = 'none';
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (role === 'user' ? 'user' : 'agent');
  const gl = MODULOS.find((m) => m.id === moduloActivo)?.gl || '⬡';
  wrap.innerHTML = `<div class="av">${role === 'user' ? 'Vos' : gl}</div><div class="bubble"></div>`;
  wrap.querySelector('.bubble').textContent = text;
  chat.appendChild(wrap);
  window.scrollTo(0, document.body.scrollHeight);
  return wrap.querySelector('.bubble');
}

async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  $('send').disabled = true;

  addMsg('user', text);
  history.push({ role: 'user', content: text });
  const bubble = addMsg('agent', '');
  bubble.classList.add('typing');
  bubble.textContent = 'Pensando…';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, modulo: moduloActivo, message: text, history: history.slice(-8) })
    });
    const data = await res.json();
    bubble.classList.remove('typing');
    if (!res.ok) throw new Error(data.error || 'Error');
    bubble.textContent = data.reply;
    history.push({ role: 'assistant', content: data.reply });
  } catch (e) {
    bubble.classList.remove('typing');
    bubble.textContent = 'Hubo un problema al responder. Probá de nuevo en unos segundos.';
  } finally {
    $('send').disabled = false;
    window.scrollTo(0, document.body.scrollHeight);
  }
}

/* ---- Estado del servidor (Render cold start) ---- */
async function checkHealth(retries = 12) {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (r.ok) { $('dot').classList.remove('warn'); $('statusText').textContent = 'En línea'; return; }
    throw new Error();
  } catch {
    if (retries > 0) {
      $('dot').classList.add('warn');
      $('statusText').textContent = 'Iniciando servidor…';
      setTimeout(() => checkHealth(retries - 1), 3000);
    } else {
      $('statusText').textContent = 'Sin conexión';
    }
  }
}

/* ---- Modales ---- */
function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => closeModal(b.dataset.close)));

$('btnLead').onclick = () => openModal('overlayLead');
$('btnTurno').onclick = () => openModal('overlayTurno');

$('l_save').onclick = async () => {
  const body = {
    sessionId,
    nombre: $('l_nombre').value.trim(),
    telefono: $('l_telefono').value.trim(),
    email: $('l_email').value.trim(),
    empresa: $('l_empresa').value.trim(),
    interes: $('l_interes').value.trim()
  };
  const msg = $('leadMsg');
  if (!body.email && !body.telefono) { msg.className = 'msg-err'; msg.textContent = 'Dejá al menos un email o teléfono.'; return; }
  try {
    const r = await fetch('/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    msg.className = 'msg-ok'; msg.textContent = '¡Listo! Te vamos a contactar a la brevedad.';
    setTimeout(() => closeModal('overlayLead'), 1400);
  } catch (e) { msg.className = 'msg-err'; msg.textContent = e.message || 'No se pudo enviar.'; }
};

$('t_save').onclick = async () => {
  const body = {
    nombre: $('t_nombre').value.trim(),
    email: $('t_email').value.trim(),
    telefono: $('t_telefono').value.trim(),
    fecha: $('t_fecha').value,
    hora: $('t_hora').value,
    motivo: $('t_motivo').value.trim()
  };
  const msg = $('turnoMsg');
  if (!body.nombre || !body.fecha) { msg.className = 'msg-err'; msg.textContent = 'Completá nombre y fecha.'; return; }
  try {
    const r = await fetch('/api/turno', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    msg.className = 'msg-ok'; msg.textContent = 'Turno solicitado. Te confirmamos pronto.';
    setTimeout(() => closeModal('overlayTurno'), 1400);
  } catch (e) { msg.className = 'msg-err'; msg.textContent = e.message || 'No se pudo solicitar.'; }
};

/* ---- Input ---- */
const input = $('input');
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; });
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('send').onclick = send;

renderModules();
renderSuggest();
checkHealth();
