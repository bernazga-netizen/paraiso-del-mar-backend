// ============================================================
// routes-auth.js — Autenticación usuarios Inhouse
// Paraíso del Mar
// ============================================================
const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── POST /api/auth/setup-password — configurar contraseña inicial ──
// Solo funciona si el usuario no tiene contraseña aún
router.post('/setup-password', async (req, res) => {
  try {
    const { nombre, password } = req.body;
    if (!nombre || !password) {
      return res.status(400).json({ ok: false, error: 'nombre y password son requeridos' });
    }
    if (password.length < 6) {
      return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 6 caracteres' });
    }

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
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { nombre, password } = req.body;
    if (!nombre || !password) {
      return res.status(400).json({ ok: false, error: 'nombre y password son requeridos' });
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

    // Actualizar último login
    await pool.query(
      `UPDATE inhouse_usuarios SET last_login = NOW() WHERE id = $1`, [u.id]
    );

    // Devolver datos del usuario (sin password_hash)
    res.json({
      ok: true,
      usuario: {
        id:     u.id,
        nombre: u.nombre,
        email:  u.email,
        rol:    u.rol
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/auth/usuarios — lista usuarios (solo admin) ─────
router.get('/usuarios', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, nombre, email, rol, activo, created_at, last_login,
              (password_hash IS NOT NULL) AS tiene_password
       FROM inhouse_usuarios ORDER BY nombre`
    );
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PUT /api/auth/usuarios/:id/password — cambiar contraseña ─
router.put('/usuarios/:id/password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `UPDATE inhouse_usuarios SET password_hash = $1 WHERE id = $2`, [hash, req.params.id]
    );
    res.json({ ok: true, mensaje: 'Contraseña actualizada' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PUT /api/auth/usuarios/:id — activar/desactivar usuario ──
router.put('/usuarios/:id', async (req, res) => {
  try {
    const { activo } = req.body;
    const r = await pool.query(
      `UPDATE inhouse_usuarios SET activo = $1 WHERE id = $2 RETURNING id, nombre, activo`,
      [activo, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'No encontrado' });
    res.json({ ok: true, data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
