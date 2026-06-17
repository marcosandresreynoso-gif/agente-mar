// admin.js — Panel de administración
const $ = (id) => document.getElementById(id);
let KEY = sessionStorage.getItem('mar_admin') || '';

const TABS = [
  ['resumen', 'Resumen'],
  ['leads', 'Leads'],
  ['conversaciones', 'Conversaciones'],
  ['documentos', 'Documentos'],
  ['turnos', 'Turnos'],
  ['config', 'Configuración']
];

async function api(pathname, opts = {}) {
  const res = await fetch(pathname, {
    ...opts,
    headers: { 'x-admin-key': KEY, ...(opts.headers || {}) }
  });
  if (res.status === 401) { logout(); throw new Error('Sesión vencida.'); }
  return res;
}

function esc(s) { return String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }
function fecha(iso) { try { return new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }); } catch { return iso; } }

/* ---- Login ---- */
$('loginBtn').onclick = async () => {
  const password = $('pass').value;
  const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  if (r.ok) { KEY = password; sessionStorage.setItem('mar_admin', KEY); start(); }
  else { const d = await r.json(); $('loginMsg').className = 'msg-err'; $('loginMsg').textContent = d.error || 'Contraseña incorrecta.'; }
};
$('pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });

function logout() { sessionStorage.removeItem('mar_admin'); KEY = ''; $('app').style.display = 'none'; $('login').style.display = 'block'; }
$('logout').onclick = (e) => { e.preventDefault(); logout(); };

/* ---- Tabs ---- */
function renderTabs() {
  const c = $('tabs'); c.innerHTML = '';
  TABS.forEach(([id, label], i) => {
    const el = document.createElement('div');
    el.className = 'tab' + (i === 0 ? ' active' : '');
    el.textContent = label;
    el.onclick = () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      el.classList.add('active');
      document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === id));
      loadPane(id);
    };
    c.appendChild(el);
  });
}

/* ---- Resumen ---- */
async function loadStats() {
  const d = await (await api('/api/admin/stats')).json();
  const t = d.totales, s = d.semana;
  $('cards').innerHTML = `
    <div class="card"><div class="k">Consultas (7 días)</div><div class="v">${s.totalConsultas}</div></div>
    <div class="card"><div class="k">Leads (7 días)</div><div class="v">${s.totalLeads}</div></div>
    <div class="card"><div class="k">Turnos (7 días)</div><div class="v">${s.turnos}</div></div>
    <div class="card"><div class="k">Total leads</div><div class="v">${t.leads} <small>histórico</small></div></div>
    <div class="card"><div class="k">Total consultas</div><div class="v">${t.consultas} <small>histórico</small></div></div>
    <div class="card"><div class="k">Documentos cargados</div><div class="v">${t.documentos}</div></div>`;
}
$('genReport').onclick = () => runReport(false);
$('sendReport').onclick = () => runReport(true);
async function runReport(send) {
  $('reportBox').textContent = 'Generando…';
  try {
    const days = $('repDays').value;
    const d = await (await api(`/api/admin/report?days=${days}${send ? '&send=1' : ''}`)).json();
    $('reportBox').textContent = (send ? '✓ Enviado por email.\n\n' : '') + d.text;
  } catch (e) { $('reportBox').textContent = 'Error: ' + e.message; }
}

/* ---- Leads ---- */
async function loadLeads() {
  const rows = await (await api('/api/admin/leads')).json();
  $('leadCount').textContent = `${rows.length} leads`;
  if (!rows.length) { $('leadsTable').innerHTML = '<div class="empty">Todavía no hay leads. Aparecen acá automáticamente cuando alguien deja sus datos o los menciona en el chat.</div>'; return; }
  let h = '<table><tr><th>Fecha</th><th>Nombre</th><th>Contacto</th><th>Empresa</th><th>Interés</th><th>Fuente</th></tr>';
  for (const r of rows) {
    h += `<tr><td>${fecha(r.created_at)}</td><td>${esc(r.nombre)}</td>
      <td>${esc(r.email || '')}<br><span class="status">${esc(r.telefono || '')}</span></td>
      <td>${esc(r.empresa || '')}</td><td>${esc(r.interes || '')}</td>
      <td><span class="badge">${esc(r.fuente || '')}</span></td></tr>`;
  }
  $('leadsTable').innerHTML = h + '</table>';
}
$('exportCsv').onclick = async () => {
  const r = await api('/api/admin/leads.csv');
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'leads-mar.csv'; a.click();
  URL.revokeObjectURL(url);
};

/* ---- Conversaciones ---- */
async function loadConsultas() {
  const rows = await (await api('/api/admin/consultas')).json();
  if (!rows.length) { $('consultasTable').innerHTML = '<div class="empty">Sin conversaciones registradas.</div>'; return; }
  let h = '<table><tr><th>Fecha</th><th>Canal</th><th>Módulo</th><th>Pregunta</th><th>Respuesta</th></tr>';
  for (const r of rows) {
    h += `<tr><td>${fecha(r.created_at)}</td><td><span class="badge">${esc(r.canal || 'web')}</span></td>
      <td>${esc(r.modulo)}</td><td>${esc((r.pregunta || '').slice(0, 160))}</td>
      <td style="color:var(--muted)">${esc((r.respuesta || '').slice(0, 220))}…</td></tr>`;
  }
  $('consultasTable').innerHTML = h + '</table>';
}

/* ---- Documentos ---- */
$('uploadBtn').onclick = async () => {
  const f = $('file').files[0];
  const msg = $('uploadMsg');
  if (!f) { msg.className = 'msg-err'; msg.textContent = 'Elegí un archivo.'; return; }
  msg.className = 'status'; msg.textContent = 'Procesando documento…';
  const fd = new FormData();
  fd.append('archivo', f);
  fd.append('modulo', $('docModulo').value);
  fd.append('titulo', f.name);
  try {
    const r = await api('/api/admin/documentos', { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    msg.className = 'msg-ok'; msg.textContent = `Cargado: ${d.num_chunks} fragmentos indexados.`;
    $('file').value = '';
    loadDocs();
  } catch (e) { msg.className = 'msg-err'; msg.textContent = e.message; }
};
async function loadDocs() {
  const rows = await (await api('/api/admin/documentos')).json();
  if (!rows.length) { $('docsTable').innerHTML = '<div class="empty">Sin documentos cargados.</div>'; return; }
  let h = '<table><tr><th>Fecha</th><th>Documento</th><th>Módulo</th><th>Fragmentos</th><th></th></tr>';
  for (const r of rows) {
    h += `<tr><td>${fecha(r.created_at)}</td><td>${esc(r.titulo)}</td><td>${esc(r.modulo)}</td>
      <td>${r.num_chunks}</td><td><button class="btn ghost small" data-del="${r.id}">Eliminar</button></td></tr>`;
  }
  $('docsTable').innerHTML = h + '</table>';
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    await api('/api/admin/documentos/' + b.dataset.del, { method: 'DELETE' });
    loadDocs();
  }));
}

/* ---- Turnos ---- */
async function loadTurnos() {
  const rows = await (await api('/api/admin/turnos')).json();
  if (!rows.length) { $('turnosTable').innerHTML = '<div class="empty">Sin turnos solicitados.</div>'; return; }
  let h = '<table><tr><th>Solicitado</th><th>Nombre</th><th>Contacto</th><th>Fecha/Hora</th><th>Motivo</th><th>Estado</th></tr>';
  for (const r of rows) {
    const cls = r.estado === 'confirmado' ? 'conf' : 'pend';
    h += `<tr><td>${fecha(r.created_at)}</td><td>${esc(r.nombre)}</td>
      <td>${esc(r.email || '')}<br><span class="status">${esc(r.telefono || '')}</span></td>
      <td>${esc(r.fecha)} ${esc(r.hora || '')}</td><td>${esc(r.motivo || '')}</td>
      <td><select class="mini" data-turno="${r.id}">
        <option value="pendiente" ${r.estado === 'pendiente' ? 'selected' : ''}>Pendiente</option>
        <option value="confirmado" ${r.estado === 'confirmado' ? 'selected' : ''}>Confirmado</option>
        <option value="cancelado" ${r.estado === 'cancelado' ? 'selected' : ''}>Cancelado</option>
      </select></td></tr>`;
  }
  $('turnosTable').innerHTML = h + '</table>';
  document.querySelectorAll('[data-turno]').forEach((sel) => (sel.onchange = async () => {
    await api('/api/admin/turno/' + sel.dataset.turno, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ estado: sel.value }) });
  }));
}

/* ---- Config ---- */
const CONFIG_FIELDS = [
  ['empresa_nombre', 'Nombre de la empresa', false],
  ['empresa_descripcion', 'Descripción / qué hace', true],
  ['empresa_ubicacion', 'Ubicación', false],
  ['empresa_contacto', 'Email de contacto', false],
  ['tono', 'Tono del agente', true]
];
async function loadConfig() {
  const c = await (await api('/api/admin/config')).json();
  let h = '';
  for (const [k, label, big] of CONFIG_FIELDS) {
    const val = esc(c[k] || '');
    h += `<div class="field"><label>${label}</label>` +
      (big ? `<textarea id="cfg_${k}" rows="3">${val}</textarea>` : `<input id="cfg_${k}" value="${val}" />`) + '</div>';
  }
  $('configForm').innerHTML = h;
}
$('saveConfig').onclick = async () => {
  const body = {};
  for (const [k] of CONFIG_FIELDS) body[k] = $('cfg_' + k).value;
  await api('/api/admin/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  $('configMsg').className = 'msg-ok'; $('configMsg').textContent = 'Configuración guardada.';
  setTimeout(() => ($('configMsg').textContent = ''), 2000);
};

/* ---- Router ---- */
function loadPane(id) {
  if (id === 'resumen') loadStats();
  if (id === 'leads') loadLeads();
  if (id === 'conversaciones') loadConsultas();
  if (id === 'documentos') loadDocs();
  if (id === 'turnos') loadTurnos();
  if (id === 'config') loadConfig();
}

function start() {
  $('login').style.display = 'none';
  $('app').style.display = 'block';
  renderTabs();
  loadStats();
}

if (KEY) start();
