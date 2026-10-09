// src/telefono.js — Normaliza teléfonos al formato que usa WhatsApp (sin +, sin espacios).
// Argentina: 549 + código de área + número (sin el 0 ni el 15). Ej: 5492388412345
// Devuelve null si el número no sirve.

function normalizarTelefono(input) {
  if (input === null || input === undefined) return null;
  let d = String(input).replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);

  let nacional = null;
  if (d.startsWith('54')) {
    nacional = d.slice(2);
    if (nacional.startsWith('9')) nacional = nacional.slice(1);
  } else if (d.length >= 10 && d.length <= 13 && (d.startsWith('0') || d.length <= 12)) {
    // Número argentino escrito en formato local (con o sin 0 / 15)
    nacional = d;
  } else {
    // Internacional de otro país: lo dejamos tal cual
    return d.length >= 8 && d.length <= 15 ? d : null;
  }

  nacional = nacional.replace(/^0+/, '');

  // Sacar el "15" que va después del código de área (área de 2, 3 o 4 dígitos)
  if (nacional.length === 12) {
    for (const a of [2, 3, 4]) {
      if (nacional.slice(a, a + 2) === '15') {
        nacional = nacional.slice(0, a) + nacional.slice(a + 2);
        break;
      }
    }
  }

  if (nacional.length !== 10) return null;
  return '549' + nacional;
}

// Para mostrar lindo en el panel: +54 9 2388 41-2345 (aprox.)
function mostrarTelefono(t) {
  if (!t) return '';
  if (/^549\d{10}$/.test(t)) return `+54 9 ${t.slice(3, 7)} ${t.slice(7)}`;
  return '+' + t;
}

module.exports = { normalizarTelefono, mostrarTelefono };
