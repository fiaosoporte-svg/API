const express = require('express');
const cors = require('cors');
const { pool } = require('./db');
const { manejarErrores } = require('./errores');
const rutas = require('./rutas');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // detrás de un proxy (Render, Railway, Nginx...) para conocer la IP real en los límites de intentos

const origenes = (process.env.CORS_ORIGEN || '*').split(',').map((o) => o.trim());
app.use(cors({ origin: origenes.includes('*') ? true : origenes }));
app.use(express.json({ limit: '100kb' }));

app.get('/salud', async (_req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false, error: 'Sin conexión con la base de datos' });
  }
});

app.use('/v1', rutas);
app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.use(manejarErrores);

// Render (y casi todos los hostings) asignan el puerto en PORT.
const puerto = Number(process.env.PORT || process.env.PUERTO || 3000);
app.listen(puerto, () => console.log(`API de filo. escuchando en el puerto ${puerto}`));
