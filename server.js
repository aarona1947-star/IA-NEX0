require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({limit:'10mb'}));
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════
// PROMPTS ESPECIALIZADOS POR IA
// ═══════════════════════════════════════════════
const PROMPTS = {
  info: `Eres NEXO-INFO, un especialista en investigación e información. Tu función es:
- Buscar y presentar información precisa y actualizada
- Explicar hechos, conceptos, historia y ciencia con claridad
- Dar respuestas verificables con contexto completo
- Organizar información de forma estructurada con puntos clave
Siempre responde en español. Usa listas y estructura cuando ayude. Si no sabes algo, dilo claramente.`,

  code: `Eres NEXO-CODE, un experto en programación y matemáticas. Tu función es:
- Resolver problemas de código en cualquier lenguaje
- Explicar algoritmos y estructuras de datos
- Hacer cálculos matemáticos y estadísticos
- Depurar errores y optimizar código
- Dar ejemplos prácticos con código funcional
Siempre responde en español. Usa bloques de código con sintaxis apropiada. Explica cada paso.`,

  create: `Eres NEXO-CREATE, un asistente creativo especializado en arte y expresión. Tu función es:
- Escribir textos creativos: historias, poemas, guiones, letras
- Generar ideas creativas e innovadoras
- Crear descripciones detalladas para imágenes (prompts)
- Ayudar con diseño, marketing y contenido visual
- Dar feedback creativo y sugerencias artísticas
Siempre responde en español. Sé expresivo, imaginativo y original.`,

  sage: `Eres NEXO-SAGE, un asistente de análisis profundo y conocimiento extenso. Tu función es:
- Analizar temas complejos desde múltiples perspectivas
- Discutir filosofía, ética, sociedad y cultura
- Dar respuestas extensas y detalladas cuando se requiera
- Conectar ideas entre diferentes disciplinas
- Razonar paso a paso sobre problemas complejos
Siempre responde en español. Sé reflexivo, matizado y exhaustivo en tus análisis.`
};

// ═══════════════════════════════════════════════
// FUNCIÓN GEMINI (con fallback de modelos)
// ═══════════════════════════════════════════════
async function llamarGemini(history, text, sistemaPrompt) {
  const key = (process.env.GEMINI_KEY || '').trim();
  if (!key || key.startsWith('PEGA_')) throw new Error('Agrega tu GEMINI_KEY en .env — gratis en aistudio.google.com');

  const historial = (history||[]).slice(-14).map(m=>({
    role: m.role==='assistant' ? 'model' : 'user',
    parts: [{text: m.content}]
  }));

  const modelos = ['gemini-2.5-flash-lite','gemini-2.5-flash','gemini-2.0-flash-lite','gemini-1.5-flash'];

  for (const modelo of modelos) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${key}`, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          system_instruction: {parts:[{text: sistemaPrompt}]},
          contents: [...historial, {role:'user', parts:[{text}]}],
          generationConfig: {maxOutputTokens:1500, temperature:0.7}
        })
      });
      const raw = await r.text();
      let json; try{json=JSON.parse(raw);}catch{continue;}
      if(json.error){console.log('[skip]',modelo,json.error.message);continue;}
      const reply = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if(!reply) continue;
      console.log(`✅ Gemini [${modelo}]`);
      return reply;
    } catch(e){console.log('[err]',modelo,e.message);}
  }
  throw new Error('Gemini: todos los modelos fallaron. Verifica tu clave en aistudio.google.com');
}

// ═══════════════════════════════════════════════
// RUTAS — 4 IAs especializadas
// ═══════════════════════════════════════════════
app.post('/api/info', async(req,res)=>{
  try{res.json({reply: await llamarGemini(req.body.history, req.body.text, PROMPTS.info)});}
  catch(e){res.status(500).json({error:'🔍 '+e.message});}
});

app.post('/api/code', async(req,res)=>{
  try{res.json({reply: await llamarGemini(req.body.history, req.body.text, PROMPTS.code)});}
  catch(e){res.status(500).json({error:'💻 '+e.message});}
});

app.post('/api/create', async(req,res)=>{
  try{res.json({reply: await llamarGemini(req.body.history, req.body.text, PROMPTS.create)});}
  catch(e){res.status(500).json({error:'🎨 '+e.message});}
});

app.post('/api/sage', async(req,res)=>{
  try{res.json({reply: await llamarGemini(req.body.history, req.body.text, PROMPTS.sage)});}
  catch(e){res.status(500).json({error:'🧠 '+e.message});}
});

// ═══════════════════════════════════════════════
// ELEVENLABS TTS
// ═══════════════════════════════════════════════
app.post('/api/tts', async(req,res)=>{
  const key=(process.env.ELEVENLABS_KEY||'').trim();
  if(!key||key.startsWith('PEGA_')){
    return res.status(400).json({error:'Agrega ELEVENLABS_KEY en .env — gratis en elevenlabs.io'});
  }
  const texto=(req.body.text||'').slice(0,400);
  if(!texto) return res.status(400).json({error:'Sin texto'});
  const voiceId = process.env.ELEVENLABS_VOICE || 'onwK4e9ZLuTAKqWW03F9';
  try{
    const r=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,{
      method:'POST',
      headers:{'xi-api-key':key,'Content-Type':'application/json','Accept':'audio/mpeg'},
      body:JSON.stringify({
        text:texto, model_id:'eleven_multilingual_v2',
        voice_settings:{stability:0.5,similarity_boost:0.75,style:0.3,use_speaker_boost:true}
      })
    });
    if(!r.ok){const err=await r.json().catch(()=>({}));throw new Error(err.detail?.message||`HTTP ${r.status}`);}
    const buffer=await r.buffer();
    res.set('Content-Type','audio/mpeg');
    res.send(buffer);
  }catch(e){res.status(500).json({error:'ElevenLabs: '+e.message});}
});

// ═══════════════════════════════════════════════
// IMÁGENES — Pollinations AI (gratis)
// ═══════════════════════════════════════════════
app.post('/api/imagen', async(req,res)=>{
  const{prompt}=req.body;
  if(!prompt) return res.status(400).json({error:'Falta el prompt'});
  const p=encodeURIComponent(prompt.slice(0,400));
  const seed=Math.floor(Math.random()*999999);
  res.json({imageUrl:`https://image.pollinations.ai/prompt/${p}?width=768&height=768&seed=${seed}&nologo=true&nofeed=true`});
});

// ═══════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════
app.get('/api/status',(req,res)=>{
  res.json({
    gemini: !!(process.env.GEMINI_KEY&&!process.env.GEMINI_KEY.startsWith('PEGA_')),
    tts:    !!(process.env.ELEVENLABS_KEY&&!process.env.ELEVENLABS_KEY.startsWith('PEGA_')),
  });
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT,()=>{
  const gemini=process.env.GEMINI_KEY&&!process.env.GEMINI_KEY.startsWith('PEGA_');
  const tts=process.env.ELEVENLABS_KEY&&!process.env.ELEVENLABS_KEY.startsWith('PEGA_');
  console.log('\n  ┌────────────────────────────────┐');
  console.log('  │      🧠  IA-NEXO  v5.0         │');
  console.log(`  │  http://localhost:${PORT}          │`);
  console.log('  └────────────────────────────────┘\n');
  console.log('  4 IAs Especializadas:');
  console.log('  🔍 NEXO-INFO   — Información y datos');
  console.log('  💻 NEXO-CODE   — Código y matemáticas');
  console.log('  🎨 NEXO-CREATE — Creatividad e imágenes');
  console.log('  🧠 NEXO-SAGE   — Análisis profundo\n');
  console.log(`  Gemini:     ${gemini?'✅':'❌  Agrega GEMINI_KEY en .env'}`);
  console.log(`  ElevenLabs: ${tts?'✅ Voz natural':'⚠️  Sin narrador (opcional)'}`);
  console.log(`  Imágenes:   ✅ Pollinations AI (gratis)\n`);
});
