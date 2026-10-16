// oficina.js — Oficina MARTOKEN (equipo de agentes)
const $ = (id) => document.getElementById(id);
// En la app del celular la sesión queda guardada (si marcaste "Recordarme")
const leer = (k) => { try { return localStorage.getItem(k) || sessionStorage.getItem(k) || ''; } catch (e) { return ''; } };
let KEY = leer('mar_admin');
let AGENTES = [];
let porId = {};
let agenteAbierto = null;
const chats = {};           // chats de HOY por agente (se guardan en el servidor y en el dispositivo)
const hoyAR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
let HOY = hoyAR();
let DIAS = [];              // [{dia, agente, n}] días con chats guardados en el servidor
let diaVista = HOY;         // día que se está mirando en el chat abierto
let chatViejo = null;       // mensajes del día anterior que se está mirando
let misionVista = null;     // id de la misión que se muestra
let timerMision = null;

const SALAS = [
  { t: 'Dirección', ids: ['directora'] },
  { t: 'Comercial', ids: ['captacion', 'prospeccion'] },
  { t: 'Inversores y Marketing', ids: ['atencion', 'marketing'] },
  { t: 'Legal y Cumplimiento', ids: ['legal', 'cumplimiento'] },
  { t: 'Finanzas y Proyectos', ids: ['finanzas', 'analista'] }
];
const IDEAS = [
  'Plan para conseguir 300 preinscriptos para MAR-50 este mes',
  '5 anuncios para Facebook e Instagram que lleven a la preinscripción de MAR-50',
  'Mensajes de WhatsApp para los interesados que todavía no se preinscribieron en MAR-50',
  'Lista de municipios, gremios y empresas para difundir MAR-50 y el primer mensaje para cada uno',
  'Preguntas frecuentes de MAR-50 con sus respuestas',
  'Revisá que la comunicación de MAR-50 no tenga riesgos regulatorios'
];
const EST = { pendiente: 'en cola', trabajando: 'trabajando', lista: 'lista', error: 'error', planificando: 'planificando', terminada: 'terminada' };

/* ---------- utilidades ---------- */
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'x-admin-key': KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (res.status === 401) { salir(); throw new Error('Sesión vencida.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const hora = (iso) => iso ? new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

// Markdown simple → HTML (títulos, negrita, listas, tablas, párrafos). Todo se lee hacia abajo.
function md(txt) {
  const lines = esc(txt).split('\n');
  let html = '', lista = null, tabla = [];
  const fmt = (l) => l.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\s)\*(\S[^*]*?)\*/g, '$1<b>$2</b>');
  const cerrar = () => { if (lista) { html += `</${lista}>`; lista = null; } };
  const celdas = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => fmt(c.trim()));
  const volcarTabla = () => {
    if (!tabla.length) return;
    const filas = tabla.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).map(celdas);
    tabla = [];
    if (!filas.length) return;
    const [cab, ...cuerpo] = filas.length > 1 ? filas : [[], ...filas];
    // Cada fila es una ficha: "Columna: valor" uno debajo del otro
    html += '<div class="mdt">' + cuerpo.map((f) => '<div class="mdt-fila">' + f.map((c, k) =>
      `<div><span class="mdt-k">${cab[k] || ''}</span>${cab[k] ? ' ' : ''}${c}</div>`).join('') + '</div>').join('') + '</div>';
  };
  for (const raw of lines) {
    if (/^\s*\|/.test(raw)) { cerrar(); tabla.push(raw); continue; }
    volcarTabla();
    const l = fmt(raw);
    let m;
    if ((m = l.match(/^\s*#{1,6}\s+(.*)/))) { cerrar(); html += `<h4>${m[1]}</h4>`; }
    else if ((m = l.match(/^\s*[-•*]\s+(.*)/))) { if (lista !== 'ul') { cerrar(); html += '<ul>'; lista = 'ul'; } html += `<li>${m[1]}</li>`; }
    else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (lista !== 'ol') { cerrar(); html += '<ol>'; lista = 'ol'; } html += `<li>${m[1]}</li>`; }
    else if (/^\s*-{3,}\s*$/.test(l)) { cerrar(); html += '<hr>'; }
    else if (l.trim()) { cerrar(); html += `<p>${l}</p>`; }
    else cerrar();
  }
  volcarTabla(); cerrar();
  return html;
}
function avatar(id, cls = '') {
  const a = porId[id] || { color: '#888', inicial: '?' };
  return `<div class="avatar ${cls}" style="background:${a.color}">${esc(a.inicial)}<span class="dot"></span></div>`;
}

/* ---------- login ---------- */
async function entrar() {
  const p = $('pass').value;
  try {
    const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: p }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error');
    KEY = p;
    try { sessionStorage.setItem('mar_admin', p); if ($('recordar').checked) localStorage.setItem('mar_admin', p); } catch (e) {}
    iniciar();
  } catch (e) { $('loginMsg').textContent = e.message; }
}
function salir() { try { sessionStorage.removeItem('mar_admin'); localStorage.removeItem('mar_admin'); } catch (e) {} KEY = ''; $('app').style.display = 'none'; $('login').style.display = 'block'; }

/* ---------- oficina ---------- */
async function cargarOficina() {
  const d = await api('/api/admin/equipo');
  AGENTES = d.agentes; porId = Object.fromEntries(AGENTES.map((a) => [a.id, a]));
  const ocupados = Object.fromEntries(d.ocupados.map((o) => [o.agente, o.tarea]));
  $('planta').innerHTML = SALAS.map((s) => `
    <div class="sala"><h4>${esc(s.t)}</h4>
      ${s.ids.map((id) => { const a = porId[id]; if (!a) return ''; const oc = ocupados[id];
        return `<div class="puesto ${oc ? 'ocupado' : ''}" data-id="${id}" title="${esc(oc || a.lema)}">
          ${avatar(id)}
          <div style="min-width:0"><div class="nm">${esc(a.nombre)}</div><div class="rl">${esc(a.puesto)}</div>
          <div class="st">${oc ? '● trabajando en una misión' : '● disponible'}</div></div></div>`; }).join('')}
    </div>`).join('');
  document.querySelectorAll('.puesto').forEach((el) => el.onclick = () => abrirFicha(el.dataset.id));
  const n = Object.keys(ocupados).length;
  $('estadoGral').textContent = `${AGENTES.length} agentes · ${n ? n + ' trabajando' : 'todos disponibles'} · Groq: ${d.groq_keys} de 4 keys`;
  $('feed').innerHTML = d.actividad.length
    ? d.actividad.map((x) => `<div>${hora(x.finished_at)} · <b>${esc(porId[x.agente]?.nombre || x.agente)}</b> ${x.estado === 'error' ? 'tuvo un error en' : 'terminó'}: ${esc(x.tarea.slice(0, 80))}</div>`).join('')
    : '<div>Sin actividad todavía.</div>';
  $('nAcc').textContent = d.acciones_pendientes;
  if ($('focoTxt').style.display === 'none') { FOCO = d.foco; $('focoVer').innerHTML = md(FOCO); }
}

/* ---------- foco del equipo ---------- */
let FOCO = '';
function editarFoco(on) {
  $('focoTxt').style.display = on ? 'block' : 'none';
  $('focoVer').style.display = on ? 'none' : 'block';
  $('focoEditar').style.display = on ? 'none' : '';
  $('focoGuardar').style.display = $('focoCancelar').style.display = on ? '' : 'none';
  if (on) { $('focoTxt').value = FOCO; $('focoTxt').focus(); }
  $('focoMsg').textContent = '';
}
async function guardarFoco() {
  $('focoGuardar').disabled = true;
  try {
    const r = await post('/api/admin/equipo/foco', { foco: $('focoTxt').value });
    FOCO = r.foco; $('focoVer').innerHTML = md(FOCO); editarFoco(false);
    $('focoMsg').textContent = 'Guardado. El equipo ya trabaja con este foco.';
  } catch (e) { $('focoMsg').textContent = e.message; }
  $('focoGuardar').disabled = false;
}

/* ---------- ficha y chat ---------- */
function abrirFicha(id) {
  const a = porId[id]; agenteAbierto = id;
  $('fAv').outerHTML = `<div class="avatar big" id="fAv" style="background:${a.color}">${esc(a.inicial)}</div>`;
  $('fNombre').textContent = a.nombre; $('fPuesto').textContent = `${a.puesto} · ${a.area}`;
  $('fPerfil').innerHTML = `
    <p class="muted" style="margin-top:0">“${esc(a.lema)}”</p>
    <h5>Responsabilidades</h5><ul>${a.responsabilidades.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    <h5>Herramientas</h5><div class="chips">${a.herramientas.map((h) => `<span class="chip">${esc(h)}</span>`).join('')}</div>
    <h5>Autonomía</h5><p style="margin:0;font-size:14px">${esc(a.autonomia)}</p>
    <p class="muted" style="margin-top:14px">Ningún agente envía, publica, paga ni firma solo: todo lo que proponga queda en “Esperan tu aprobación”.</p>`;
  diaVista = HOY; chatViejo = null; armarSelectorDias();
  pintarChat(); tab('perfil');
  $('ficha').classList.add('open'); $('fichaBg').classList.add('open');
}
function cerrarFicha() { $('ficha').classList.remove('open'); $('fichaBg').classList.remove('open'); agenteAbierto = null; }
function tab(t) {
  document.querySelectorAll('.ftab').forEach((x) => x.classList.toggle('active', x.dataset.t === t));
  $('fPerfil').style.display = t === 'perfil' ? 'block' : 'none';
  $('fChat').style.display = t === 'chat' ? 'block' : 'none';
  $('chatIn').style.display = t === 'chat' ? 'flex' : 'none';
  if (t === 'chat') setTimeout(() => $('chatTxt').focus(), 50);
}
function pintarChat() {
  guardarLocal();
  const viendoHoy = diaVista === HOY;
  $('chatAviso').style.display = viendoHoy ? 'none' : 'block';
  $('chatIn').style.visibility = viendoHoy ? 'visible' : 'hidden';
  const h = viendoHoy ? (chats[agenteAbierto] || []) : (chatViejo || []);
  const a = porId[agenteAbierto];
  $('msgs').innerHTML = h.length
    ? h.map((m) => `<div class="msg ${m.role === 'user' ? 'me' : 'ag'} md">${m.role === 'user' ? esc(m.content) : md(m.content)}</div>`).join('')
    : `<div class="muted">Hablale directo a ${esc(a.nombre)}. Por ejemplo: “${esc(a.responsabilidades[0])}”.</div>`;
  $('fChat').scrollTop = $('fChat').scrollHeight;
}
async function enviarChat() {
  const txt = $('chatTxt').value.trim(); if (!txt || !agenteAbierto) return;
  const id = agenteAbierto; const h = chats[id] = chats[id] || [];
  const history = h.slice();
  h.push({ role: 'user', content: txt }); $('chatTxt').value = ''; pintarChat();
  $('msgs').insertAdjacentHTML('beforeend', '<div class="msg ag muted" id="pensando">Escribiendo…</div>');
  $('chatEnviar').disabled = true;
  try {
    const r = await post('/api/admin/equipo/chat', { agente: id, message: txt, history });
    let c = r.reply;
    if (r.acciones && r.acciones.length) c += `\n\n(${r.acciones.length} acción(es) propuesta(s) enviadas a “Esperan tu aprobación”.)`;
    h.push({ role: 'assistant', content: c });
    if (r.acciones && r.acciones.length) cargarAcciones();
    if (r.mision_id) { seguirMisionEnChat(id, r.mision_id); verMision(r.mision_id); cargarHistorial(); }
  } catch (e) { h.push({ role: 'assistant', content: 'Error: ' + e.message }); }
  $('chatEnviar').disabled = false;
  if (agenteAbierto === id) pintarChat();
}

// Cuando Victoria reparte una misión desde el chat, el avance y el informe aparecen en su chat
async function seguirMisionEnChat(agenteId, misionId) {
  const h = chats[agenteId] = chats[agenteId] || [];
  const estado = { role: 'assistant', content: 'Armando el plan…' };
  h.push(estado); if (agenteAbierto === agenteId) pintarChat();
  for (let i = 0; i < 120; i++) {               // hasta ~10 minutos
    await new Promise((r) => setTimeout(r, 5000));
    let m; try { m = await api('/api/admin/equipo/mision/' + misionId); } catch (e) { continue; }
    const lineas = m.tareas.map((t) => `- ${porId[t.agente]?.nombre || t.agente} (${porId[t.agente]?.puesto || ''}): ${EST[t.estado] || t.estado}`);
    estado.content = (m.resumen_plan ? m.resumen_plan + '\n\n' : 'Armando el plan…\n\n') + lineas.join('\n');
    if (m.estado === 'terminada') {
      estado.content += '\n\nEquipo terminado.';
      let inf = '## Informe\n' + (m.informe || '');
      if (m.acciones.length) inf += `\n\n(${m.acciones.length} acción(es) para aprobar en “Esperan tu aprobación”.)`;
      h.push({ role: 'assistant', content: inf });
      post('/api/admin/equipo/chats/agregar', { agente: agenteId, role: 'assistant', content: inf }).catch(() => {});
      cargarAcciones(); cargarHistorial();
      if (agenteAbierto === agenteId) pintarChat();
      return;
    }
    if (m.estado === 'error') {
      estado.content += '\n\nNo se pudo terminar: ' + (m.error || 'error desconocido');
      if (agenteAbierto === agenteId) pintarChat();
      return;
    }
    if (agenteAbierto === agenteId) pintarChat();
  }
}

/* ---------- historial por día ---------- */
const fechaLarga = (d) => new Date(d + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
// Copia en el dispositivo (sirve de respaldo si el servidor se borra con un deploy)
function guardarLocal() {
  try {
    const todo = JSON.parse(localStorage.getItem('oficina_chats') || '{}');
    const delDia = {};
    for (const [ag, msgs] of Object.entries(chats)) if (msgs.length) delDia[ag] = msgs.map((m) => ({ role: m.role, content: m.content }));
    if (Object.keys(delDia).length) todo[HOY] = delDia;
    const dias = Object.keys(todo).sort().reverse().slice(0, 90);   // últimos 90 días
    localStorage.setItem('oficina_chats', JSON.stringify(Object.fromEntries(dias.map((d) => [d, todo[d]]))));
  } catch (e) {}
}
function leerLocal() { try { return JSON.parse(localStorage.getItem('oficina_chats') || '{}'); } catch (e) { return {}; } }

async function sincronizarChats() {
  const r = await api('/api/admin/equipo/chats/dias');
  HOY = r.hoy || hoyAR(); diaVista = HOY;
  const enServidor = new Set(r.dias.map((x) => x.dia + '|' + x.agente));
  // Subir lo que el dispositivo tiene y el servidor perdió
  const local = leerLocal(); let subidos = 0;
  for (const [dia, porAg] of Object.entries(local)) {
    for (const [ag, msgs] of Object.entries(porAg || {})) {
      if (!enServidor.has(dia + '|' + ag) && Array.isArray(msgs) && msgs.length) {
        try { await post('/api/admin/equipo/chats/restaurar', { dia, agente: ag, mensajes: msgs }); subidos++; } catch (e) {}
      }
    }
  }
  DIAS = subidos ? (await api('/api/admin/equipo/chats/dias')).dias : r.dias;
  // Bajar al dispositivo los días que tiene el servidor y el dispositivo no (copia completa, últimos 90 días)
  try {
    const todo = leerLocal(); let cambio = false;
    const faltan = [...new Set(DIAS.filter((x) => x.dia !== HOY && !(todo[x.dia] && todo[x.dia][x.agente])).map((x) => x.dia))].slice(0, 90);
    for (const dia of faltan) {
      const c = (await api('/api/admin/equipo/chats?dia=' + dia)).chats || {};
      todo[dia] = { ...(todo[dia] || {}), ...c }; cambio = true;
    }
    if (cambio) localStorage.setItem('oficina_chats', JSON.stringify(todo));
  } catch (e) {}
  const hoy = await api('/api/admin/equipo/chats?dia=' + HOY);
  for (const k of Object.keys(chats)) delete chats[k];
  Object.assign(chats, hoy.chats || {});
}
function armarSelectorDias() {
  const dias = DIAS.filter((x) => x.agente === agenteAbierto && x.dia !== HOY).map((x) => x.dia);
  $('chatDia').innerHTML = `<option value="${HOY}">Hoy · ${fechaLarga(HOY)}</option>` +
    dias.map((d) => `<option value="${d}">${fechaLarga(d)}</option>`).join('');
  $('chatDia').value = diaVista;
}
async function cambiarDia() {
  diaVista = $('chatDia').value; chatViejo = null;
  if (diaVista !== HOY) {
    $('msgs').innerHTML = '<div class="muted">Cargando…</div>';
    try { chatViejo = ((await api('/api/admin/equipo/chats?dia=' + diaVista)).chats || {})[agenteAbierto] || []; }
    catch (e) { chatViejo = (leerLocal()[diaVista] || {})[agenteAbierto] || []; }
  }
  pintarChat();
}
function descargarDia() {
  const a = porId[agenteAbierto]; if (!a) return;
  const msgs = diaVista === HOY ? (chats[agenteAbierto] || []) : (chatViejo || []);
  if (!msgs.length) return;
  const txt = `Oficina Martoken — Chat con ${a.nombre} (${a.puesto})\nDía: ${fechaLarga(diaVista)}\n\n` +
    msgs.map((m) => `${m.role === 'user' ? 'Marcos' : a.nombre}:\n${m.content}\n`).join('\n');
  const url = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `chat-${a.nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()}-${diaVista}.txt`;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------- misiones ---------- */
async function encargar() {
  const pedido = $('pedido').value.trim(); if (!pedido) return;
  $('btnMision').disabled = true; $('misionMsg').textContent = 'Enviando a la Directora…';
  try {
    const r = await post('/api/admin/equipo/mision', { pedido });
    $('pedido').value = ''; $('misionMsg').textContent = '';
    verMision(r.id); cargarHistorial();
  } catch (e) { $('misionMsg').textContent = e.message; }
  $('btnMision').disabled = false;
}
async function verMision(id) {
  misionVista = id; clearTimeout(timerMision);
  let m;
  try { m = await api('/api/admin/equipo/mision/' + id); } catch (e) { $('misionActual').innerHTML = `<div class="card muted">${esc(e.message)}</div>`; return; }
  if (misionVista !== id) return;
  const enCurso = m.estado === 'planificando' || m.estado === 'trabajando';
  $('misionActual').innerHTML = `
    <div class="card">
      <div style="display:flex; gap:10px; align-items:flex-start;">
        ${avatar('directora')}
        <div style="flex:1">
          <div style="font-weight:600">${esc(m.pedido)}</div>
          <div class="muted">${hora(m.created_at)} · ${m.resumen_plan ? esc(m.resumen_plan) : 'Victoria está armando el plan…'}</div>
        </div>
        <span class="badge ${m.estado}">${EST[m.estado] || m.estado}</span>
      </div>
      <div style="margin-top:12px">
        ${m.tareas.map((t) => `
          <div class="tarea">${avatar(t.agente)}
            <div style="flex:1; min-width:0">
              <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
                <b style="font-size:14px">${esc(porId[t.agente]?.nombre || t.agente)}</b>
                <span class="muted">${esc(porId[t.agente]?.puesto || '')}</span>
                <span class="badge ${t.estado}">${EST[t.estado] || t.estado}</span>
              </div>
              <div style="font-size:13.5px; margin-top:2px">${esc(t.tarea)}</div>
              ${t.resultado ? `<details class="res"><summary>Ver lo que hizo</summary><div class="md">${md(t.resultado)}</div></details>` : ''}
            </div>
          </div>`).join('')}
      </div>
      ${m.informe ? `<div class="informe"><div class="section-t" style="margin:0 0 6px">Informe de Victoria</div><div class="md">${md(m.informe)}</div></div>` : ''}
      ${m.error ? `<div class="informe" style="border-color:var(--err);background:rgba(239,107,107,.08)">No se pudo terminar: ${esc(m.error)}</div>` : ''}
      ${m.acciones.length ? `<div class="muted" style="margin-top:10px">Esta misión dejó ${m.acciones.length} acción(es) para que apruebes (columna de la derecha).</div>` : ''}
    </div>`;
  if (enCurso) timerMision = setTimeout(() => { verMision(id); cargarOficina().catch(() => {}); }, 4000);
  else { cargarOficina().catch(() => {}); cargarAcciones(); cargarHistorial(); }
}
async function cargarHistorial() {
  const l = await api('/api/admin/equipo/misiones');
  $('historial').innerHTML = l.length
    ? l.map((m) => `<div class="hist-item" data-id="${m.id}"><div class="p">${esc(m.pedido.slice(0, 110))}</div><div class="muted">${hora(m.created_at)} · <span class="badge ${m.estado}">${EST[m.estado] || m.estado}</span></div></div>`).join('')
    : '<div class="muted">Todavía no hay misiones.</div>';
  document.querySelectorAll('.hist-item').forEach((el) => el.onclick = () => { verMision(Number(el.dataset.id)); window.scrollTo({ top: $('misionActual').offsetTop - 80, behavior: 'smooth' }); });
}
async function cargarAcciones() {
  const l = await api('/api/admin/equipo/acciones');
  $('nAcc').textContent = l.length;
  $('acciones').innerHTML = l.length
    ? l.map((a) => `<div class="accion">${avatar(a.agente)}
        <div class="txt"><b>${esc(porId[a.agente]?.nombre || a.agente)}</b> propone:<br>${esc(a.descripcion)}<div class="muted">${hora(a.created_at)}</div></div>
        <div class="btns"><button class="btn small ok" data-a="${a.id}" data-v="1">Aprobar</button><button class="btn small ghost" data-a="${a.id}" data-v="0">Descartar</button></div></div>`).join('')
      + '<p class="muted" style="margin-bottom:0">Aprobar deja registro de tu decisión: la acción la hacés vos (o la ejecutamos desde WhatsApp / el panel).</p>'
    : '<div class="muted">Nada pendiente.</div>';
  document.querySelectorAll('[data-a]').forEach((b) => b.onclick = async () => {
    b.disabled = true;
    await post('/api/admin/equipo/accion/' + b.dataset.a, { aprobar: b.dataset.v === '1' });
    cargarAcciones();
  });
}

/* ---------- arranque ---------- */
async function iniciar() {
  $('login').style.display = 'none'; $('app').style.display = 'block';
  try {
    await cargarOficina();
    await Promise.all([cargarHistorial(), cargarAcciones(), sincronizarChats().catch(() => {})]);
    const ult = (await api('/api/admin/equipo/misiones'))[0];
    if (ult) verMision(ult.id);
  } catch (e) { $('estadoGral').textContent = e.message; }
}
$('ideas').innerHTML = IDEAS.map((i) => `<button class="idea">${esc(i)}</button>`).join('');
document.querySelectorAll('.idea').forEach((b) => b.onclick = () => { $('pedido').value = b.textContent; $('pedido').focus(); });
$('loginBtn').onclick = entrar;
$('pass').onkeydown = (e) => { if (e.key === 'Enter') entrar(); };
$('logout').onclick = (e) => { e.preventDefault(); salir(); };
$('btnMision').onclick = encargar;
$('focoEditar').onclick = () => editarFoco(true);
$('focoCancelar').onclick = () => editarFoco(false);
$('focoGuardar').onclick = guardarFoco;
$('pedido').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) encargar(); };
$('fCerrar').onclick = cerrarFicha; $('fichaBg').onclick = cerrarFicha;
document.querySelectorAll('.ftab').forEach((t) => t.onclick = () => tab(t.dataset.t));
$('chatEnviar').onclick = enviarChat;
$('chatDia').onchange = cambiarDia;
$('chatBajar').onclick = descargarDia;
$('chatTxt').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarChat(); } };
setInterval(() => { if (KEY && !document.hidden) { cargarOficina().catch(() => {}); } }, 20000);

if (KEY) iniciar(); else $('login').style.display = 'block';

/* ---------- instalar como app ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw-oficina.js').catch(() => {}));
}
let pedidoInstalar = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); pedidoInstalar = e;
  $('instalarApp').style.display = ''; $('sepInstalar').style.display = '';
});
$('instalarApp').onclick = async (e) => {
  e.preventDefault();
  if (!pedidoInstalar) return;
  pedidoInstalar.prompt();
  await pedidoInstalar.userChoice.catch(() => {});
  pedidoInstalar = null; $('instalarApp').style.display = 'none'; $('sepInstalar').style.display = 'none';
};
window.addEventListener('appinstalled', () => { $('instalarApp').style.display = 'none'; $('sepInstalar').style.display = 'none'; });
