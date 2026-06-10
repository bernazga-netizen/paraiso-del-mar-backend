// routes-seguridad-auth.js — Autenticación módulo seguridad
const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { Pool } = require('pg');
const { JWT_SECRET, JWT_EXPIRES_IN } = require('./middlewares/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// POST /api/seguridad/auth/login
router.post('/login', async (req, res) => {
  try {
    const nombre   = req.body.nombre ? req.body.nombre.trim().substring(0, 100) : null;
    const password = req.body.password;

    if (!nombre || !password) {
      return res.status(400).json({ success: false, error: 'nombre y password son requeridos' });
    }
    if (typeof password !== 'string' || password.length > 100) {
      return res.status(400).json({ success: false, error: 'Datos inválidos' });
    }

    const result = await pool.query(
      `SELECT * FROM seguridad_usuarios WHERE nombre ILIKE $1 AND activo = TRUE`,
      [nombre]
    );

    if (!result.rows.length) {
      return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos' });
    }

    const u = result.rows[0];

    const match = await bcrypt.compare(password, u.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos' });
    }

    const token = jwt.sign(
      { id: u.id, nombre: u.nombre, rol: u.rol, sistema: 'seguridad' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      success: true,
      token,
      usuario: {
        id:     u.id,
        nombre: u.nombre,
        rol:    u.rol
      }
    });
  } catch (err) {
    console.error('seguridad login:', err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// GET /api/seguridad/auth/guardias — lista de guardias activos para selector
router.get('/guardias', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nombre FROM seguridad_usuarios
       WHERE activo = TRUE AND rol = 'guardia'
       ORDER BY nombre`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

module.exports = router;
