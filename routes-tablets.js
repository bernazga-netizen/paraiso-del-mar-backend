// ============================================================
// routes-tablets.js — PIN de tablets de acceso, Paraíso del Mar
// ------------------------------------------------------------
// - Los PIN se guardan hasheados (bcrypt) en accesos_tablet_pins.
// - POST /api/tablets/verify valida el PIN en el servidor y
//   devuelve un token de tablet (firmado con clave distinta a la
//   de usuarios, para que no abra rutas del dashboard).
// - verifyTablet protege POST /api/registros y exige que el
//   acceso del registro coincida con el de la tablet.
// - GET/PUT /api/tablets/pins permiten al admin consultar y
//   cambiar los PIN desde el dashboard.
// - Semilla inicial: si una tablet no tiene PIN en la base y
//   existe la variable TABLET_PIN_<CLAVE> (MUELLE, BASE4, BASE1),
//   se guarda ese PIN. Después de la semilla, la variable ya no
//   se usa.
// ============================================================
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { Pool } = require('pg');
const { verifyToken, JWT_SECRET } = require('./middlewares/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const TABLETS = {
  muelle: { acceso: 'Muelle Principal', env: 'TABLET_PIN_MUELLE' },
  base4:  { acceso: 'Base 4',           env: 'TABLET_PIN_BASE4'  },
  base1:  { acceso: 'Base 1',           env: 'TABLET_PIN_BASE1'  },
};

// Clave separada para tokens de tablet: un token de tablet no sirve en rutas con verifyToken.
const TABLET_SECRET = crypto.createHash('sha256').update('tablet-token:' + JWT_SECRET).digest('hex');
const TABLET_TOKEN_TTL = '12h';

const MAX_INTENTOS = 5;
const BLOQUEO_MS   = 5 * 60 * 1000;
const intentos = new Map(); // tablet -> { fallos, bloqueadoHasta }

const PIN_REGEX = /^\d{4}$/;

// ── Esquema y semilla ───────────────────────────────────────
const listo = (async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accesos_tablet_pins (
      tablet_key VARCHAR(20) PRIMARY KEY,
      acceso     VARCHAR(50) NOT NULL,
      pin_hash   VARCHAR(100) NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  for (const [key, cfg] of Object.entries(TABLETS)) {
    const existe = await pool.query('SELECT 1 FROM accesos_tablet_pins WHERE tablet_key = $1', [key]);
    const semilla = process.env[cfg.env];
    if (existe.rows.length === 0 && semilla && PIN_REGEX.test(semilla)) {
      const hash = await bcrypt.hash(semilla, 10);
      await pool.query(
        'INSERT INTO accesos_tablet_pins (tablet_key, acceso, pin_hash) VALUES ($1, $2, $3)',
        [key, cfg.acceso, hash]
      );
      console.log(`✓ PIN inicial creado para tablet ${key}`);
    }
  }
})().catch(err => {
  console.error('Error al preparar PIN de tablets:', err.message);
});

// ── Middlewares ─────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.user || req.user.rol !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Acceso denegado. Se requiere rol admin.' });
  }
  next();
}

function verifyTablet(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Sesión de tablet requerida. Ingresa el PIN.' });
  }
  try {
    const payload = jwt.verify(token, TABLET_SECRET);
    if (payload.rol !== 'tablet') throw new Error('rol inválido');
    if (req.body && req.body.acceso !== payload.acceso) {
      return res.status(403).json({ ok: false, error: 'La tablet no puede registrar en otro punto de acceso.' });
    }
    req.tablet = payload;
    next();
  } catch {
    return res.status(403).json({ ok: false, error: 'Sesión de tablet inválida o expirada. Ingresa el PIN de nuevo.' });
  }
}

// ── Públicas (tablets) ──────────────────────────────────────
router.post('/verify', async (req, res) => {
  const { tablet, pin } = req.body || {};
  const cfg = TABLETS[tablet];
  if (!cfg) return res.status(404).json({ ok: false, error: 'Tablet no válida' });

  const estado = intentos.get(tablet) || { fallos: 0, bloqueadoHasta: 0 };
  if (estado.bloqueadoHasta > Date.now()) {
    return res.status(429).json({ ok: false, error: 'Demasiados intentos. Espera 5 minutos.' });
  }
  if (typeof pin !== 'string' || !PIN_REGEX.test(pin)) {
    return res.status(400).json({ ok: false, error: 'PIN incorrecto' });
  }

  try {
    await listo;
    const { rows } = await pool.query('SELECT pin_hash FROM accesos_tablet_pins WHERE tablet_key = $1', [tablet]);
    if (rows.length === 0) {
      return res.status(503).json({ ok: false, error: 'PIN no configurado para esta tablet' });
    }

    const correcto = await bcrypt.compare(pin, rows[0].pin_hash);
    if (!correcto) {
      estado.fallos += 1;
      if (estado.fallos >= MAX_INTENTOS) {
        estado.bloqueadoHasta = Date.now() + BLOQUEO_MS;
        estado.fallos = 0;
      }
      intentos.set(tablet, estado);
      return res.status(401).json({ ok: false, error: 'PIN incorrecto' });
    }

    intentos.delete(tablet);
    const token = jwt.sign({ rol: 'tablet', tablet, acceso: cfg.acceso }, TABLET_SECRET, { expiresIn: TABLET_TOKEN_TTL });
    res.json({ ok: true, token, tablet, acceso: cfg.acceso });
  } catch (error) {
    console.error('Error al verificar PIN de tablet:', error);
    res.status(500).json({ ok: false, error: 'Error al verificar el PIN' });
  }
});

// ── Admin (dashboard) ───────────────────────────────────────
router.get('/pins', verifyToken, requireAdmin, async (req, res) => {
  try {
    await listo;
    const { rows } = await pool.query(
      'SELECT tablet_key, acceso, updated_at FROM accesos_tablet_pins ORDER BY tablet_key'
    );
    res.json({ ok: true, tablets: rows });
  } catch (error) {
    console.error('Error al listar PIN de tablets:', error);
    res.status(500).json({ ok: false, error: 'Error al consultar los PIN' });
  }
});

router.put('/pins/:key', verifyToken, requireAdmin, async (req, res) => {
  const { key } = req.params;
  const cfg = TABLETS[key];
  if (!cfg) return res.status(404).json({ ok: false, error: 'Tablet no válida' });

  const { pin } = req.body || {};
  if (typeof pin !== 'string' || !PIN_REGEX.test(pin)) {
    return res.status(400).json({ ok: false, error: 'El PIN debe tener exactamente 4 dígitos.' });
  }

  try {
    await listo;
    const hash = await bcrypt.hash(pin, 10);
    await pool.query(
      `INSERT INTO accesos_tablet_pins (tablet_key, acceso, pin_hash, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (tablet_key)
       DO UPDATE SET pin_hash = EXCLUDED.pin_hash, updated_at = NOW()`,
      [key, cfg.acceso, hash]
    );
    intentos.delete(key);
    console.log(`PIN de tablet ${key} actualizado por ${req.user.nombre}`);
    res.json({ ok: true, mensaje: `PIN de ${cfg.acceso} actualizado` });
  } catch (error) {
    console.error('Error al actualizar PIN de tablet:', error);
    res.status(500).json({ ok: false, error: 'Error al guardar el PIN' });
  }
});

module.exports = router;
module.exports.verifyTablet = verifyTablet;
