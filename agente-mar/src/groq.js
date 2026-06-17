// src/groq.js — Cliente del modelo (Groq) con prompts por módulo + contexto de documentos
const { getConfig } = require('./db');
const rag = require('./rag');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const MODULOS = {
  comercial: {
    nombre: 'Comercial',
    foco:
      'Ventas, captación de clientes, propuesta de valor, marketing, pricing de servicios y posicionamiento.'
  },
  contable: {
    nombre: 'Contable',
    foco:
      'AFIP, monotributo, categorías, inscripciones, facturación, retenciones y obligaciones impositivas en Argentina.'
  },
  finanzas: {
    nombre: 'Finanzas',
    foco:
      'Organización de finanzas personales y del negocio, flujo de caja, costos, márgenes, inversión y rentabilidad.'
  },
  legal: {
    nombre: 'Legal',
    foco:
      'Contratos, protección de propiedad intelectual, formas societarias, fideicomisos y riesgos legales del emprendedor.'
  },
  todos: {
    nombre: 'Integral',
    foco:
      'Visión integral: combina lo comercial, contable, financiero y legal según lo que necesite la consulta.'
  }
};

function systemPrompt(modulo, contexto) {
  const cfg = getConfig();
  const m = MODULOS[modulo] || MODULOS.todos;
  let base =
    `Sos el Agente Integral de ${cfg.empresa_nombre}. ` +
    `${cfg.empresa_descripcion} Ubicación: ${cfg.empresa_ubicacion}.\n\n` +
    `Estás operando en el módulo ${m.nombre}. Foco: ${m.foco}\n\n` +
    `Tono: ${cfg.tono}\n` +
    `Reglas:\n` +
    `- Respuestas concretas y accionables, sin relleno.\n` +
    `- Si la consulta excede tu módulo, respondés igual pero aclarás brevemente desde qué área.\n` +
    `- Si no sabés algo con certeza, lo decís; no inventás datos legales ni impositivos.\n` +
    `- Cuando detectes interés real, invitá a dejar nombre y contacto para que un asesor siga la conversación.\n`;

  if (contexto && contexto.trim()) {
    base +=
      `\nDOCUMENTACIÓN DE LA EMPRESA (usá esto como fuente principal cuando aplique; ` +
      `si la respuesta está acá, basate en esto antes que en conocimiento general):\n"""\n${contexto}\n"""\n`;
  }
  return base;
}

async function chat({ modulo = 'todos', message, history = [] }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('Falta GROQ_API_KEY en las variables de entorno.');

  // Recuperar fragmentos relevantes de los documentos cargados
  let contexto = '';
  try {
    contexto = rag.retrieve(message, modulo, 4);
  } catch (e) {
    contexto = '';
  }

  const msgs = [
    { role: 'system', content: systemPrompt(modulo, contexto) },
    ...history.slice(-8).map((h) => ({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: String(h.content || '').slice(0, 4000)
    })),
    { role: 'user', content: String(message).slice(0, 4000) }
  ];

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: msgs,
      temperature: 0.4,
      max_tokens: 900
    })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || 'No pude generar una respuesta en este momento.';
}

// Llamada genérica al modelo (para extracción de leads y reportes)
async function complete(systemMsg, userMsg, { json = false, maxTokens = 700 } = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('Falta GROQ_API_KEY.');
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemMsg },
      { role: 'user', content: userMsg }
    ],
    temperature: 0.1,
    max_tokens: maxTokens
  };
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Groq ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

module.exports = { chat, complete, MODULOS };
