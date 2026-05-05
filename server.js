require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SISTEMA = 'Eres IA-NEXO, un asistente de inteligencia artificial avanzado. Responde SIEMPRE en español, de forma clara, precisa y útil. Puedes ayudar con programación, ciencias, creatividad, matemáticas y cualquier otro tema.';

function msgs(history, text) {
  return [
    { role: 'system', content: SISTEMA },
    ...(history || []).slice(-12),
    { role: 'user', content: text }
  ];
}

// ═══════════════════════════════════════════════
// 20+ MODELOS GRATUITOS — se prueban en orden
// Si uno falla, pasa automaticamente al siguiente
// ═══════════════════════════════════════════════
const TODOS_LOS_MODELOS = [
  // Google Gemma (muy buenos, poco tráfico)
  'google/gemma-4-31b-it:free',
  'google/gemma-3-12b-it:free',
  'google/gemma-3-4b-it:free',
  'google/gemma-3-1b-it:free',
  'google/gemma-2-9b-it:free',
  // Qwen (Alibaba, excelentes en español)
  'qwen/qwen3-8b:free',
  'qwen/qwen3-14b:free',
  'qwen/qwen3-30b-a3b:free',
  'qwen/qwen3-235b-a22b:free',
  // DeepSeek (muy capaces)
  'deepseek/deepseek-r1-0528-qwen3-8b:free',
  'deepseek/deepseek-r1-zero:free',
  'deepseek/deepseek-v3-base:free',
  // Microsoft Phi
  'microsoft/phi-4-reasoning-plus:free',
  'microsoft/phi-3-mini-128k-instruct:free',
  'microsoft/phi-3-medium-128k-instruct:free',
  // Meta Llama
  'meta-llama/llama-3.2-3b-instruct:free',
  'meta-llama/llama-3.1-8b-instruct:free',
  'meta-llama/llama-3.2-11b-vision-instruct:free',
  // Mistral
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'mistralai/devstral-small-2505:free',
  // Otros
  'nvidia/llama-3.1-nemotron-nano-8b-v1:free',
  'featherless/qwerky-72b:free',
  'thudm/glm-4-9b-chat:free',
];

// Grupos por "personalidad" de cada botón del chat
const GRUPOS = {
  llama:    ['meta-llama/llama-3.2-3b-instruct:free', 'meta-llama/llama-3.1-8b-instruct:free', 'meta-llama/llama-3.2-11b-vision-instruct:free'],
  mistral:  ['mistralai/mistral-small-3.1-24b-instruct:free', 'mistralai/devstral-small-2505:free'],
  gemma:    ['google/gemma-4-31b-it:free', 'google/gemma-3-12b-it:free', 'google/gemma-3-4b-it:free', 'google/gemma-2-9b-it:free'],
  qwen:     ['qwen/qwen3-8b:free', 'qwen/qwen3-14b:free', 'qwen/qwen3-30b-a3b:free'],
};

// ═══════════════════════════════════════════════
// FUNCIÓN PRINCIPAL — intenta modelos hasta lograr respuesta
// ═══════════════════════════════════════════════
async function llamar(history, text, preferidos = []) {
  const key = (process.env.OPENROUTER_KEY || '').trim();

  if (!key || key === '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' || key.length < 20) {
    throw new Error('Abre el archivo .env y pega tu clave de openrouter.ai/keys');
  }

  // Intentar preferidos primero, luego todos los demás
  const lista = [...new Set([...preferidos, ...TODOS_LOS_MODELOS])];
  const errores = [];

  for (const modelo of lista) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${key}`,
          'HTTP-Referer':  'https://ia-nex0-production.up.railway.app',
          'X-Title':       'IA-NEXO'
        },
        body: JSON.stringify({
          model:       modelo,
          messages:    msgs(history, text),
          max_tokens:  1200,
          temperature: 0.7
        })
      });

      const json = await r.json();

      // Si es error de cuota o modelo no disponible, probar el siguiente
      if (json.error) {
        const msg = json.error.message || json.error.code || 'error';
        errores.push(modelo.split('/').pop() + ': ' + msg.slice(0, 60));
        continue;
      }

      const reply = json.choices?.[0]?.message?.content?.trim();
      if (!reply) { errores.push(modelo.split('/').pop() + ': vacío'); continue; }

      console.log(`✅ Respondió: ${modelo}`);
      return reply;

    } catch (e) {
      errores.push(modelo.split('/').pop() + ': ' + e.message.slice(0, 40));
    }
  }

  throw new Error('Todos los modelos están ocupados. Intenta en 1 minuto.\n' + errores.slice(0, 3).join(' | '));
}

// ═══════════════════════════════════════════════
// RUTAS — un endpoint por modelo/grupo
// ═══════════════════════════════════════════════
app.post('/api/llama', async (req, res) => {
  try { res.json({ reply: await llamar(req.body.history, req.body.text, GRUPOS.llama) }); }
  catch (e) { res.status(500).json({ error: '🦙 ' + e.message }); }
});

app.post('/api/mistral-free', async (req, res) => {
  try { res.json({ reply: await llamar(req.body.history, req.body.text, GRUPOS.mistral) }); }
  catch (e) { res.status(500).json({ error: '🌊 ' + e.message }); }
});

app.post('/api/gemma', async (req, res) => {
  try { res.json({ reply: await llamar(req.body.history, req.body.text, GRUPOS.gemma) }); }
  catch (e) { res.status(500).json({ error: '💎 ' + e.message }); }
});

app.post('/api/qwen', async (req, res) => {
  try { res.json({ reply: await llamar(req.body.history, req.body.text, GRUPOS.qwen) }); }
  catch (e) { res.status(500).json({ error: '🌸 ' + e.message }); }
});

app.post('/api/chatgpt', async (req, res) => {
  const key = process.env.OPENAI_KEY;
  if (!key) return res.status(400).json({ error: 'Agrega OPENAI_KEY en Railway Variables → platform.openai.com' });
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'gpt-4o', messages: msgs(req.body.history, req.body.text), max_tokens: 1500 })
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error?.message || r.status);
    res.json({ reply: json.choices[0].message.content });
  } catch (e) { res.status(500).json({ error: 'ChatGPT: ' + e.message }); }
});

app.post('/api/deepseek', async (req, res) => {
  const key = process.env.DEEPSEEK_KEY;
  if (!key) return res.status(400).json({ error: 'Agrega DEEPSEEK_KEY en Railway Variables → platform.deepseek.com' });
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages: msgs(req.body.history, req.body.text), max_tokens: 1500 })
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error?.message || r.status);
    res.json({ reply: json.choices[0].message.content });
  } catch (e) { res.status(500).json({ error: 'DeepSeek: ' + e.message }); }
});

app.post('/api/grok', async (req, res) => {
  const key = process.env.GROK_KEY;
  if (!key) return res.status(400).json({ error: 'Agrega GROK_KEY en Railway Variables → console.x.ai' });
  try {
    const r = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'grok-2-latest', messages: msgs(req.body.history, req.body.text), max_tokens: 1500 })
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error?.message || r.status);
    res.json({ reply: json.choices[0].message.content });
  } catch (e) { res.status(500).json({ error: 'Grok: ' + e.message }); }
});

// ═══════════════════════════════════════════════
// STATUS y TEST
// ═══════════════════════════════════════════════
app.get('/api/status', (req, res) => {
  const or = !!(process.env.OPENROUTER_KEY &&
    process.env.OPENROUTER_KEY !== 'PEGA_TU_CLAVE_AQUI' &&
    process.env.OPENROUTER_KEY.length > 20);
  res.json({
    llama: or, mistral: or, gemma: or, qwen: or,
    chatgpt:  !!process.env.OPENAI_KEY,
    deepseek: !!process.env.DEEPSEEK_KEY,
    grok:     !!process.env.GROK_KEY
  });
});

app.get('/api/test', async (req, res) => {
  try {
    const reply = await llamar([], 'Di exactamente: "IA-NEXO funcionando correctamente"', []);
    res.json({ ok: true, respuesta: reply });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ═══════════════════════════════════════════════
// INICIO
// ═══════════════════════════════════════════════
app.listen(PORT, () => {
  const keyOk = process.env.OPENROUTER_KEY &&
    process.env.OPENROUTER_KEY !== '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' &&
    process.env.OPENROUTER_KEY.length > 20;

  console.log('\n  ┌────────────────────────────────┐');
  console.log('  │      🧠  IA-NEXO  v3.0         │');
  console.log(`  │  http://localhost:${PORT}          │`);
  console.log('  └────────────────────────────────┘\n');
  console.log(`  OpenRouter: ${keyOk ? '✅ Listo' : '❌  Abre .env y pega tu clave'}`);
  console.log(`  Modelos gratis: ${TODOS_LOS_MODELOS.length} disponibles\n`);

  if (!keyOk) {
    console.log('  ⚠️  IMPORTANTE:');
    console.log('  Abre el archivo .env y reemplaza');
    console.log('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');
    console.log('  openrouter.ai/keys\n');
  }
});