# 🧠 IA-NEXO v4.0

## Instalación (una sola vez)
1. Doble clic en install.bat

## Configurar claves GRATIS (sin tarjeta)

### Gemini — Google (recomendado, fácil)
1. Ve a aistudio.google.com
2. Inicia sesión con Google
3. Clic en "Get API Key" > "Create API key"
4. Copia la clave (AIza...)
5. Abre .env y reemplaza: GEMINI_KEY=AIza...tu-clave

### HuggingFace (backup)
1. Ve a huggingface.co
2. Sign up con Google
3. huggingface.co/settings/tokens > New Token > Read > Generate
4. Copia el token (hf_...)
5. Abre .env y reemplaza: HF_KEY=hf_...tu-token

## Iniciar local
Doble clic en start.bat
Abre Chrome: http://localhost:3000

## Subir a Railway (online)
1. git add -A
2. git commit -m "update"  
3. git push origin main
4. Railway > Variables > agrega GEMINI_KEY y HF_KEY
