// wa-panel.js — Panel WhatsApp M-AR
const $ = (id) => document.getElementById(id);
let KEY = sessionStorage.getItem('mar_admin') || '';
let actual = null;          // teléfono de la conversación abierta
let seleccion = new Set();  // contactos elegidos para campaña
let contactosCache = [];
let plantillas = [];
let timerConv = null, timerCamp = null;

const ESTADOS = ['nuevo', 'contactado', 'respondio', 'interesado', 'cliente', 'descartado', 'baja'];
const ESTADO_TXT = { nuevo: 'Nuevo', contactado: 'Contactado', respondio: 'Respondió', interesado: 'Interesado', cliente: 'Cliente', descartado: 'Descartado', baja: 'Baja' };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'x-admin-key': KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  if (res.status === 401) { logout(); throw new Error('Sesión vencida.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

function esc(s) { return String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }
function hora(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const hoy = new Date().toDateString() === d.toDateString();
  return d.toLocaleString('es-AR', hoy ? { timeStyle: 'short' } : { dateStyle: 'short', timeStyle: 'short' });
}
function fuenteBadge(f) {
  const t = { anuncio: 'anuncio', buscador: 'buscador', whatsapp: 'whatsapp', manual: 'manual' }[f] || f || '-';
  return `<span class="badge ${f === 'anuncio' ? 'anuncio' : f === 'buscador' ? 'buscador' : ''}">${esc(t)}</span>`;
}
// *negrita* de WhatsApp → <b>
function waFormat(t) { return esc(t).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/_([^_\n]+)_/g, '<i>$1</i>'); }

/* ---------------- Login ---------------- */
$('loginBtn').onclick = async () => {
  const password = $('pass').value;
  const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  if (r.ok) { KEY = password; sessionStorage.setItem('mar_admin', KEY); start(); }
  else { $('loginMsg').className = 'msg-err'; $('loginMsg').textContent = 'Contraseña incorrecta.'; }
};
$('pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });
function logout() { sessionStorage.removeItem('mar_admin'); KEY = ''; $('app').style.display = 'none'; $('login').style.display = 'block'; }
$('logout').onclick = (e) => { e.preventDefault(); logout(); };

/* ---------------- Tabs ---------------- */
document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => abrirTab(t.dataset.t);
});
function abrirTab(id) {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.t === id));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === id));
  if (id === 'bandeja') cargarBandeja();
  if (id === 'contactos') cargarContactos();
  if (id === 'campania') cargarCampania();
  if (id === 'ajustes') cargarAjustes();
}

/* ---------------- Resumen (punto verde, no leídos) ---------------- */
let resumenCache = null;
async function cargarResumen() {
  try {
    resumenCache = await api('/api/admin/wa/resumen');
    $('botDot').className = 'dot' + (resumenCache.bot_activo ? '' : ' warn');
    $('botTxt').textContent = resumenCache.bot_activo ? 'Bot activo' : 'Bot apagado';
    const n = resumenCache.no_leidos;
    $('nNoLeidos').style.display = n ? 'inline' : 'none';
    $('nNoLeidos').textContent = n;
  } catch {}
  return resumenCache;
}

/* ---------------- Bandeja ---------------- */
async function cargarBandeja() {
  const lista = await api('/api/admin/wa/contactos?filtro=conversaciones').catch(() => []);
  if (!lista.length) {
    $('convList').innerHTML = '<div class="empty">Todavía no hay conversaciones. Cuando alguien escriba desde el anuncio aparece acá.</div>';
    return;
  }
  $('convList').innerHTML = lista.map((c) => `
    <div class="item ${c.telefono === actual ? 'sel' : ''}" data-tel="${esc(c.telefono)}">
      <div class="top">
        <span class="name">${esc(c.empresa || c.nombre || c.telefono_vista)}</span>
        ${c.no_leidos ? `<span class="unread">${c.no_leidos}</span>` : ''}
        <span class="muted" style="font-size:11px">${hora(c.ultima_actividad)}</span>
      </div>
      <div class="top" style="margin-top:4px">${fuenteBadge(c.fuente)}
        <span class="badge">${ESTADO_TXT[c.estado] || esc(c.estado)}</span>
        ${!c.bot_activo || (c.pausa_hasta && c.pausa_hasta > new Date().toISOString()) ? '<span class="badge warn">vos</span>' : ''}
      </div>
      <div class="prev">${esc(c.ultimo_texto || '')}</div>
    </div>`).join('');
  $('convList').querySelectorAll('.item').forEach((el) => (el.onclick = () => abrirConversacion(el.dataset.tel)));
}

async function abrirConversacion(tel, scroll = true) {
  actual = tel;
  $('inbox').classList.add('open');
  let d;
  try { d = await api('/api/admin/wa/conversacion/' + encodeURIComponent(tel)); } catch (e) { return; }
  const c = d.contacto;
  const pausado = c.pausa_hasta && c.pausa_hasta > new Date().toISOString();
  const botTxt = !c.bot_activo ? 'Bot apagado con este contacto' : pausado ? `Bot pausado hasta ${hora(c.pausa_hasta)}` : 'Bot respondiendo';
  const prevScroll = $('msgs') ? $('msgs').scrollTop : 0;

  $('thread').innerHTML = `
    <div class="thead">
      <button class="btn ghost small back" id="backBtn">←</button>
      <div class="who"><b>${esc(c.empresa || c.nombre || c.telefono_vista)}</b>
        <span class="muted">${esc(c.telefono_vista)}${c.rubro ? ' · ' + esc(c.rubro) : ''}${c.anuncio ? ' · anuncio: ' + esc(c.anuncio) : ''}</span></div>
      <select class="mini" id="estadoSel">${ESTADOS.map((e) => `<option value="${e}" ${e === c.estado ? 'selected' : ''}>${ESTADO_TXT[e]}</option>`).join('')}</select>
      <button class="btn ghost small" id="botBtn" title="${esc(botTxt)}">${c.bot_activo && !pausado ? '🤖 Pausar bot' : '🤖 Activar bot'}</button>
      <a class="btn ghost small" href="https://wa.me/${esc(c.telefono)}" target="_blank" title="Abrir en WhatsApp">↗</a>
    </div>
    <div class="msgs" id="msgs">${d.mensajes.map((m) => `
      <div class="b ${m.direccion === 'out' ? 'out' : ''} ${m.estado === 'failed' ? 'fail' : ''}">${waFormat(m.contenido)}<div class="meta">${m.direccion === 'out' ? ({ bot: '🤖', marcos: 'vos (panel)', celular: 'vos (celu)', campania: 'campaña' }[m.autor] || '') + ' · ' : ''}${hora(m.created_at)}${m.direccion === 'out' ? ' · ' + ({ sent: '✓', delivered: '✓✓', read: '✓✓ leído', failed: '✗ ' + esc(m.error || 'falló') }[m.estado] || '') : ''}</div></div>`).join('') || '<div class="empty">Sin mensajes</div>'}
    </div>
    ${c.ventana_abierta
      ? `<div class="compose"><textarea class="mini" id="txt" placeholder="Escribí tu respuesta…"></textarea><button class="btn" id="sendBtn">Enviar</button></div>`
      : `<div class="aviso">Pasaron más de 24 hs desde su último mensaje: solo se le puede escribir con una plantilla aprobada (pestaña Campaña).</div>`}
  `;
  const box = $('msgs');
  box.scrollTop = scroll ? box.scrollHeight : prevScroll;

  $('backBtn').onclick = () => { actual = null; $('inbox').classList.remove('open'); cargarBandeja(); };
  $('estadoSel').onchange = async (e) => { await post('/api/admin/wa/contacto/' + tel, { estado: e.target.value }); cargarBandeja(); };
  $('botBtn').onclick = async () => {
    const activar = !(c.bot_activo && !pausado);
    await post('/api/admin/wa/contacto/' + tel, { bot_activo: activar, reanudar: activar });
    abrirConversacion(tel); cargarBandeja();
  };
  if ($('sendBtn')) {
    $('sendBtn').onclick = async () => {
      const texto = $('txt').value.trim();
      if (!texto) return;
      $('sendBtn').disabled = true;
      try { await post('/api/admin/wa/enviar', { telefono: tel, texto }); $('txt').value = ''; await abrirConversacion(tel); }
      catch (e) { alert(e.message); }
      $('sendBtn').disabled = false;
    };
    $('txt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('sendBtn').click(); });
  }
  cargarResumen();
}

/* ---------------- Contactos ---------------- */
let qTimer = null;
$('q').oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(cargarContactos, 300); };
$('filtro').onchange = cargarContactos;

async function cargarContactos() {
  const q = encodeURIComponent($('q').value.trim());
  const f = encodeURIComponent($('filtro').value);
  contactosCache = await api(`/api/admin/wa/contactos?filtro=${f}&q=${q}`).catch(() => []);
  if (!contactosCache.length) { $('contactosTable').innerHTML = '<div class="empty">No hay contactos con ese filtro.</div>'; actualizarSel(); return; }
  $('contactosTable').innerHTML = `<table><thead><tr>
      <th><input type="checkbox" id="selAll" /></th><th>Contacto</th><th>Teléfono</th><th class="hide-m">Rubro</th><th>Origen</th><th>Estado</th><th class="hide-m">Última plantilla</th>
    </tr></thead><tbody>${contactosCache.map((c) => `
      <tr>
        <td><input type="checkbox" class="sel" data-tel="${esc(c.telefono)}" ${seleccion.has(c.telefono) ? 'checked' : ''} ${c.estado === 'baja' ? 'disabled' : ''}/></td>
        <td><a href="#" class="ver" data-tel="${esc(c.telefono)}">${esc(c.empresa || c.nombre || '—')}</a></td>
        <td style="white-space:nowrap">${esc(c.telefono_vista)}</td>
        <td class="hide-m">${esc(c.rubro || '')}</td>
        <td>${fuenteBadge(c.fuente)}</td>
        <td><span class="badge ${c.estado === 'baja' ? 'err' : ['respondio', 'interesado', 'cliente'].includes(c.estado) ? 'ok' : ''}">${ESTADO_TXT[c.estado] || esc(c.estado)}</span></td>
        <td class="hide-m muted">${c.ultima_plantilla_at ? hora(c.ultima_plantilla_at) : '—'}</td>
      </tr>`).join('')}</tbody></table>`;
  document.querySelectorAll('.sel').forEach((el) => (el.onchange = () => { el.checked ? seleccion.add(el.dataset.tel) : seleccion.delete(el.dataset.tel); actualizarSel(); }));
  $('selAll').onchange = (e) => {
    document.querySelectorAll('.sel:not(:disabled)').forEach((el) => { el.checked = e.target.checked; e.target.checked ? seleccion.add(el.dataset.tel) : seleccion.delete(el.dataset.tel); });
    actualizarSel();
  };
  document.querySelectorAll('.ver').forEach((el) => (el.onclick = (e) => { e.preventDefault(); abrirTab('bandeja'); abrirConversacion(el.dataset.tel); }));
  actualizarSel();
}
function actualizarSel() {
  $('nSel').textContent = seleccion.size;
  $('aCampania').disabled = seleccion.size === 0;
}
$('selNuevos').onclick = () => { contactosCache.filter((c) => c.estado === 'nuevo').forEach((c) => seleccion.add(c.telefono)); cargarContactos(); };
$('selNada').onclick = () => { seleccion.clear(); cargarContactos(); };
$('aCampania').onclick = () => abrirTab('campania');

$('importBtn').onclick = async () => {
  const texto = $('importTxt').value;
  if (!texto.trim()) return;
  try {
    const r = await post('/api/admin/wa/importar', { texto, fuente: 'manual' });
    $('importMsg').textContent = `Agregados: ${r.nuevos} · ya estaban: ${r.existentes} · números inválidos: ${r.invalidos}`;
    $('importTxt').value = '';
    cargarContactos();
  } catch (e) { $('importMsg').textContent = e.message; }
};

/* ---------------- Campaña ---------------- */
async function cargarCampania(forzar = false) {
  const r = await cargarResumen();
  if (r) {
    const disp = Math.max(r.limite_diario - r.envios_hoy, 0);
    $('campKpis').innerHTML = `
      <div class="kpi"><div class="k">Enviadas hoy</div><div class="v">${r.envios_hoy}</div></div>
      <div class="kpi"><div class="k">Disponibles hoy</div><div class="v">${disp}</div></div>
      <div class="kpi"><div class="k">Respondieron</div><div class="v">${(r.por_estado.respondio || 0) + (r.por_estado.interesado || 0)}</div></div>
      <div class="kpi"><div class="k">Bajas</div><div class="v">${r.por_estado.baja || 0}</div></div>`;
  }
  $('destInfo').innerHTML = seleccion.size
    ? `<b>${seleccion.size}</b> contacto(s) seleccionado(s). Se saltean los que pidieron la baja y, si pasás el tope del día, el resto queda para mañana.`
    : 'Todavía no elegiste contactos. Andá a la pestaña <b>Contactos</b> y tildá a quiénes mandarle.';

  try {
    plantillas = (await api('/api/admin/wa/plantillas' + (forzar ? '?forzar=1' : ''))).filter((p) => p.estado === 'APPROVED');
    $('tplSel').innerHTML = plantillas.length
      ? '<option value="">Elegí una plantilla aprobada…</option>' + plantillas.map((p, i) => `<option value="${i}">${esc(p.nombre)} · ${esc(p.idioma)} · ${esc(p.categoria)}</option>`).join('')
      : '<option value="">No hay plantillas aprobadas todavía</option>';
    $('tplInfo').textContent = plantillas.length ? '' : 'Creá la plantilla en el Administrador de WhatsApp de Meta (o pedímela y la armamos). Meta tarda de minutos a 1-2 días en aprobarla.';
  } catch (e) {
    $('tplSel').innerHTML = '<option value="">—</option>';
    $('tplInfo').textContent = 'No pude leer las plantillas: ' + e.message;
  }
  mostrarPlantilla();
  pollCampania();
}
$('tplReload').onclick = () => cargarCampania(true);
$('tplSel').onchange = mostrarPlantilla;

function plantillaElegida() {
  const p = plantillas[$('tplSel').value];
  if (!p) return null;
  const params = [];
  for (let i = 1; i <= p.variables; i++) params.push(($('var' + i) || {}).value || '');
  const headerImagen = p.header_formato === 'IMAGE' ? ($('hdrImg') || {}).value || null : null;
  return { nombre: p.nombre, idioma: p.idioma, params, headerImagen, texto: p.texto };
}

function mostrarPlantilla() {
  const p = plantillas[$('tplSel').value];
  if (!p) { $('tplVars').innerHTML = ''; $('tplPreview').style.display = 'none'; $('enviarCamp').disabled = true; return; }
  let h = '';
  if (p.header_formato === 'IMAGE') h += `<div class="field"><label>Link de la imagen del encabezado (https://…)</label><input id="hdrImg" class="mini" style="width:100%" placeholder="https://www.martoken.com.ar/flyer.png" /></div>`;
  else if (['VIDEO', 'DOCUMENT'].includes(p.header_formato)) h += `<p class="muted" style="color:var(--warn)">Esta plantilla tiene encabezado de ${p.header_formato.toLowerCase()}: por ahora el panel no lo soporta, usá una con imagen o texto.</p>`;
  for (let i = 1; i <= p.variables; i++) {
    h += `<div class="field"><label>Variable {{${i}}}</label><input id="var${i}" class="mini" style="width:100%" value="${i === 1 ? '{empresa}' : ''}" /></div>`;
  }
  if (p.variables) h += `<p class="muted">Podés usar <code>{empresa}</code>, <code>{nombre}</code> o <code>{rubro}</code>: se reemplaza por los datos de cada contacto.</p>`;
  $('tplVars').innerHTML = h;
  $('tplVars').querySelectorAll('input').forEach((el) => (el.oninput = preview));
  preview();
}
function preview() {
  const p = plantillaElegida();
  if (!p) return;
  const ejemplo = contactosCache.find((c) => seleccion.has(c.telefono)) || { empresa: 'Ferretería López', nombre: 'Ferretería López', rubro: 'ferretería' };
  let t = (p.texto || '');
  p.params.forEach((v, i) => {
    const val = v.replace(/\{empresa\}/gi, ejemplo.empresa || ejemplo.nombre || '').replace(/\{nombre\}/gi, ejemplo.nombre || ejemplo.empresa || '').replace(/\{rubro\}/gi, ejemplo.rubro || '');
    t = t.replace(new RegExp(`\\{\\{\\s*${i + 1}\\s*\\}\\}`, 'g'), val);
  });
  const hdr = plantillas[$('tplSel').value]?.header_texto;
  $('tplPreview').style.display = 'block';
  $('tplPreview').innerHTML = `<span class="muted">Vista previa (ejemplo: ${esc(ejemplo.empresa || ejemplo.nombre)})</span>\n\n${hdr ? '<b>' + esc(hdr) + '</b>\n' : ''}${waFormat(t)}`;
  const bloqueada = ['VIDEO', 'DOCUMENT'].includes(plantillas[$('tplSel').value]?.header_formato);
  $('enviarCamp').disabled = !seleccion.size || bloqueada;
}

$('enviarCamp').onclick = async () => {
  const p = plantillaElegida();
  if (!p) return;
  if (p.headerImagen === '' || (plantillas[$('tplSel').value].header_formato === 'IMAGE' && !p.headerImagen)) return alert('Falta el link de la imagen del encabezado.');
  if (!confirm(`¿Mandar la plantilla "${p.nombre}" a ${seleccion.size} contacto(s)? Cada envío tiene costo en Meta.`)) return;
  $('enviarCamp').disabled = true;
  try {
    const r = await post('/api/admin/wa/campania', { telefonos: [...seleccion], plantilla: p, forzar: $('forzar').checked });
    $('campMsg').textContent = `Enviando ${r.aEnviar}. Salteados: ${r.salteados.length}.`;
    seleccion.clear();
    pollCampania();
  } catch (e) { $('campMsg').textContent = e.message; $('enviarCamp').disabled = false; }
};

async function pollCampania() {
  clearTimeout(timerCamp);
  const c = await api('/api/admin/wa/campania').catch(() => null);
  if (!c || !c.inicio) return;
  const hechos = c.enviados + c.fallidos;
  $('campBar').style.display = 'block';
  $('campBar').firstElementChild.style.width = (c.total ? Math.round((hechos / c.total) * 100) : 100) + '%';
  $('campMsg').textContent = c.activa
    ? `Enviando "${c.plantilla}": ${hechos} de ${c.total}…`
    : `Última campaña "${c.plantilla}": ${c.enviados} enviados, ${c.fallidos} con error, ${c.salteados} salteados.`;
  const problemas = c.detalle.filter((d) => d.resultado !== 'enviado');
  $('campDetalle').innerHTML = problemas.length
    ? `<details style="margin-top:8px"><summary class="muted">Ver salteados y errores (${problemas.length})</summary><div class="muted" style="margin-top:6px">${problemas.map((d) => `${esc(d.telefono)} — ${esc(d.resultado)}: ${esc(d.motivo)}`).join('<br>')}</div></details>`
    : '';
  if (c.activa) timerCamp = setTimeout(pollCampania, 3000);
}

/* ---------------- Ajustes ---------------- */
async function cargarAjustes() {
  const r = await cargarResumen();
  if (!r) return;
  const items = [
    ['token', 'WHATSAPP_TOKEN (token permanente)'],
    ['phone_id', 'WHATSAPP_PHONE_ID (ID del número)'],
    ['waba_id', 'WHATSAPP_WABA_ID (ID de la cuenta, para plantillas)'],
    ['verify_token', 'WHATSAPP_VERIFY_TOKEN (para verificar el webhook)'],
    ['app_secret', 'WHATSAPP_APP_SECRET (seguridad, recomendado)'],
    ['disco_persistente', 'Disco persistente en Render (para no perder conversaciones)']
  ];
  $('checklist').innerHTML = items.map(([k, t]) => `<div class="check">${r.configurado[k] ? '✅' : '⬜'} ${t}</div>`).join('');
  $('hookUrl').textContent = location.origin + '/webhook/whatsapp';
  $('botActivo').checked = r.bot_activo;
  $('instr').value = r.instrucciones;
  $('limite').value = r.limite_diario;
}
$('guardarAj').onclick = async () => {
  try {
    await post('/api/admin/wa/config', { bot_activo: $('botActivo').checked, instrucciones: $('instr').value, limite_diario: $('limite').value });
    $('ajMsg').textContent = 'Guardado ✓';
    cargarResumen();
    setTimeout(() => ($('ajMsg').textContent = ''), 2000);
  } catch (e) { $('ajMsg').textContent = e.message; }
};

/* ---------------- Inicio ---------------- */
function start() {
  $('login').style.display = 'none';
  $('app').style.display = 'block';
  cargarResumen();
  cargarBandeja();
  // Refresco automático de la bandeja cada 10 s
  clearInterval(timerConv);
  timerConv = setInterval(() => {
    if (!document.querySelector('[data-pane="bandeja"]').classList.contains('active')) return cargarResumen();
    cargarBandeja();
    if (actual && !($('txt') && $('txt').value)) abrirConversacion(actual, false);
  }, 10000);
}
if (KEY) start();
