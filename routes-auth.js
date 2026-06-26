// ============================================================
// routes-auth.js — Autenticación usuarios Inhouse
// Paraíso del Mar
// ============================================================
const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { Pool } = require('pg');
const { verifyToken, JWT_SECRET, JWT_EXPIRES_IN } = require('./middlewares/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function requireAdmin(req, res, next) {
  if (req.user.rol !== 'admin') {
    return res.status(403).json({ error: 'Acceso denegado. Se requiere rol admin.' });
  }
  next();
}

function requireGerente(req, res, next) {
  if (!['admin', 'gerente'].includes(req.user.rol)) {
    return res.status(403).json({ error: 'Acceso denegado. Se requiere rol admin o gerente.' });
  }
  next();
}

// ── Helpers de validación ────────────────────────────────────
function validarPassword(password) {
  if (!password || typeof password !== 'string') return 'La contraseña es requerida';
  if (password.length < 6)   return 'La contraseña debe tener al menos 6 caracteres';
  if (password.length > 100) return 'Contraseña demasiado larga';
  return null;
}

function sanitizarNombre(nombre) {
  if (!nombre || typeof nombre !== 'string') return null;
  return nombre.trim().substring(0, 100);
}

// ── POST /api/auth/setup-password ───────────────────────────
router.post('/setup-password', verifyToken, requireAdmin, async (req, res) => {
  try {
    const nombre   = sanitizarNombre(req.body.nombre);
    const password = req.body.password;

    if (!nombre) return res.status(400).json({ ok: false, error: 'nombre es requerido' });

    const errPass = validarPassword(password);
    if (errPass) return res.status(400).json({ ok: false, error: errPass });

    const user = await pool.query(
      `SELECT * FROM inhouse_usuarios WHERE nombre ILIKE $1 AND activo = TRUE`, [nombre]
    );
    if (!user.rows.length) {
      return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    }
    if (user.rows[0].password_hash) {
      return res.status(400).json({ ok: false, error: 'Este usuario ya tiene contraseña configurada' });
    }

    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `UPDATE inhouse_usuarios SET password_hash = $1 WHERE id = $2`,
      [hash, user.rows[0].id]
    );
    res.json({ ok: true, mensaje: 'Contraseña configurada correctamente' });
  } catch (err) {
    console.error('setup-password:', err);
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const nombre   = sanitizarNombre(req.body.nombre);
    const password = req.body.password;

    if (!nombre || !password) {
      return res.status(400).json({ ok: false, error: 'nombre y password son requeridos' });
    }
    if (typeof password !== 'string' || password.length > 100) {
      return res.status(400).json({ ok: false, error: 'Datos inválidos' });
    }

    const user = await pool.query(
      `SELECT * FROM inhouse_usuarios WHERE nombre ILIKE $1 AND activo = TRUE`, [nombre]
    );

    if (!user.rows.length) {
      return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
    }

    const u = user.rows[0];

    if (!u.password_hash) {
      return res.status(401).json({ ok: false, error: 'Este usuario aún no tiene contraseña configurada', codigo: 'SIN_PASSWORD' });
    }

    const match = await bcrypt.compare(password, u.password_hash);
    if (!match) {
      return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
    }

    await pool.query(
      `UPDATE inhouse_usuarios SET last_login = NOW() WHERE id = $1`, [u.id]
    );

    const token = jwt.sign(
      { id: u.id, nombre: u.nombre, rol: u.rol, es_guardia: u.es_guardia, acceso_condominios: u.acceso_condominios, acceso_casas: u.acceso_casas },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      ok: true,
      token,
      usuario: {
        id:                 u.id,
        nombre:             u.nombre,
        email:              u.email,
        rol:                u.rol,
        es_guardia:         u.es_guardia,
        acceso_condominios: u.acceso_condominios,
        acceso_casas:       u.acceso_casas
      }
    });
  } catch (err) {
    console.error('login:', err);
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ── GET /api/auth/usuarios ───────────────────────────────────
router.get('/usuarios', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, nombre, email, rol, activo, es_guardia, acceso_condominios, acceso_casas,
              created_at, last_login, (password_hash IS NOT NULL) AS tiene_password
       FROM inhouse_usuarios ORDER BY nombre`
    );
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('get usuarios:', err);
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ── POST /api/auth/usuarios — crear usuario (solo admin) ─────
router.post('/usuarios', verifyToken, requireAdmin, async (req, res) => {
  try {
    const nombre = sanitizarNombre(req.body.nombre);
    const { email, password, rol } = req.body;
    const acceso_condominios = req.body.acceso_condominios !== false;
    const acceso_casas       = req.body.acceso_casas       !== false;

    if (!nombre) return res.status(400).json({ ok: false, error: 'nombre es requerido' });
    if (!email || typeof email !== 'string') return res.status(400).json({ ok: false, error: 'email es requerido' });
    if (!['usuario', 'gerente', 'admin'].includes(rol)) return res.status(400).json({ ok: false, error: 'rol inválido' });

    const errPass = validarPassword(password);
    if (errPass) return res.status(400).json({ ok: false, error: errPass });

    const existe = await pool.query(`SELECT id FROM inhouse_usuarios WHERE nombre ILIKE $1`, [nombre]);
    if (existe.rows.length) return res.status(409).json({ ok: false, error: 'Ya existe un usuario con ese nombre' });

    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO inhouse_usuarios (nombre, email, password_hash, rol, acceso_condominios, acceso_casas)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, nombre, email, rol, acceso_condominios, acceso_casas`,
      [nombre, email.trim().substring(0, 200), hash, rol, acceso_condominios, acceso_casas]
    );
    res.status(201).json({ ok: true, data: r.rows[0] });
  } catch (err) {
    console.error('crear usuario:', err);
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ── PUT /api/auth/usuarios/:id/password ─────────────────────
router.put('/usuarios/:id/password', verifyToken, requireAdmin, async (req, res) => {
  try {
    const errPass = validarPassword(req.body.password);
    if (errPass) return res.status(400).json({ ok: false, error: errPass });

    const hash = await bcrypt.hash(req.body.password, 10);
    await pool.query(
      `UPDATE inhouse_usuarios SET password_hash = $1 WHERE id = $2`,
      [hash, req.params.id]
    );
    res.json({ ok: true, mensaje: 'Contraseña actualizada' });
  } catch (err) {
    console.error('update password:', err);
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ── PUT /api/auth/usuarios/:id ───────────────────────────────
router.put('/usuarios/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { activo, es_guardia } = req.body; // ← ACTUALIZADO
    const r = await pool.query(
      `UPDATE inhouse_usuarios SET activo = $1, es_guardia = $2 WHERE id = $3
       RETURNING id, nombre, activo, es_guardia`, // ← ACTUALIZADO
      [activo, es_guardia ?? false, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'No encontrado' });
    res.json({ ok: true, data: r.rows[0] });
  } catch (err) {
    console.error('toggle usuario:', err);
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ── GET /api/auth/usuarios-publico — solo nombres para login ──
router.get('/usuarios-publico', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT nombre FROM inhouse_usuarios WHERE activo = TRUE ORDER BY nombre`
    );
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

router.requireGerente = requireGerente;
module.exports = router;