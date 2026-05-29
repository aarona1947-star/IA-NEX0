require('dotenv').config();

var express = require('express');
var path    = require('path');

var config  = require('./src/config');
var db      = require('./src/db');

var app = express();

// ─── MIDDLEWARES GLOBALES ───
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── BASE DE DATOS ───
db.initMongo(config.MONGO_URI);

// ─── RUTAS ───
app.use('/auth',   require('./src/routes/auth'));
app.use('/api',    require('./src/routes/chat'));
app.use('/admin',  require('./src/routes/admin'));

// ─── PÁGINAS ───
app.get('/landing', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'landing.html')); });
app.get('/admin',   function(req, res) { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('*',        function(req, res) { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ─── ARRANQUE ───
app.listen(config.PORT, function() {
  console.log('\n  IA-NEXO v13 — Clean Architecture');
  console.log('  Puerto : ' + config.PORT);
  console.log('  Gemini : ' + (config.GEMINI_KEY && !config.GEMINI_KEY.startsWith('PEGA_') ? 'OK' : 'FALTA GEMINI_KEY'));
  console.log('  DB     : ' + (config.MONGO_URI ? 'MongoDB' : 'Archivo local'));
  console.log('  Admin  : /admin  (key: ' + config.ADMIN_KEY + ')');
  console.log('');
});
