'use strict';

// ─── CONFIGURACIÓN CENTRAL ───
// Todas las variables de entorno en un solo lugar.
// Importar con: var config = require('./config');

module.exports = {
  PORT:       process.env.PORT       || 3000,
  SECRET:     process.env.JWT_SECRET || 'nexo-secret-2025-change-this',
  ADMIN_KEY:  process.env.ADMIN_KEY  || 'nexo-admin-2025',
  GEMINI_KEY: process.env.GEMINI_KEY || '',
  MONGO_URI:  process.env.MONGO_URI  || '',
  FREE_LIMIT: parseInt(process.env.FREE_LIMIT || '25'),
  WA_BOT_KEY: process.env.WA_BOT_KEY || '',
  NTFY_CHANNEL: process.env.NTFY_CHANNEL || '',
};
