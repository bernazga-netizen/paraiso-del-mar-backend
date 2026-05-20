// ============================================================
// routes-auth.js — hardening fase 1
// ============================================================
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------
function validarPassword(password) {
  if (!password || typeof password !== 'string') return 'La contraseña es requerida';
  if (password.length < 6) return 'La contraseña debe tener al menos 6 caracteres';
  if (password.length > 100) return 'Contraseña demasiado larga';
  return null;
}

function sanitizarNombre(nombre) {
  if (!nombre || typeof nombre !== 'string') return null;
  return nombre.trim().substring(0, 100);
}

function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'];

  if (!process.env.ADMIN_API_KEY) {
    console.error('ADMIN_API_KEY no configurada');
    return res.status(500).json({
      ok: false,
      error: 'Configuración de seguridad incompleta'
    });
  }

  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({
      ok: false,
      error: 'Acceso no autorizado'
    });
  }

  next();
}

// ------------------------------------------------------------
// setup-password BLOQUEADO
// ------------------------------------------------------------
router.post('/setup-password', async (req, res) => {
  return res.status(403).json({
    ok: false,
    error: 'Endpoint deshabilitado por seguridad'
  });
});

// ------------------------------------------------------------
// login (sin romper frontend actual)
// ------------------------------------------------------------
router.post('/login', async (req, res) => {
  try {
    const nombre = sanitizarNombre(req.body.nombre);
    const password = req.body.password;

    if (!nombre || !password) {
      return res.status(400).json({
        ok: false,
        error: 'nombre y password son requeridos'
      });
    }

    if (typeof password !== 'string' || password.length > 100) {
      return res.status(400).json({
        ok: false,
        error: 'Datos inválidos'
      });
    }

    const user = await pool.query(
      `SELECT * FROM inhouse_usuarios
       WHERE nombre ILIKE $1
       AND activo = TRUE`,
      [nombre]
    );

    if (!user.rows.length) {
      return res.status(401).json({
        ok: false,
        error: 'Usuario o contraseña incorrectos'
      });
    }

    const u = user.rows[0];

    if (!u.password_hash) {
      return res.status(401).json({
        ok: false,
        error: 'Cuenta sin contraseña configurada'
      });
    }

    const match = await bcrypt.compare(password, u.password_hash);

    if (!match) {
      return res.status(401).json({
        ok: false,
        error: 'Usuario o contraseña incorrectos'
      });
    }

    await pool.query(
      `UPDATE inhouse_usuarios
       SET last_login = NOW()
       WHERE id = $1`,
      [u.id]
    );

    res.json({
      ok: true,
      usuario: {
        id: u.id,
        nombre: u.nombre,
        email: u.email,
        rol: u.rol
      }
    });

  } catch (err) {
    console.error('login:', err);
    res.status(500).json({
      ok: false,
      error: 'Error interno del servidor'
    });
  }
});

// ------------------------------------------------------------
// usuarios protegidos
// ------------------------------------------------------------
router.get('/usuarios', requireAdminKey, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        id,
        nombre,
        email,
        rol,
        activo,
        created_at,
        last_login,
        (password_hash IS NOT NULL) AS tiene_password
      FROM inhouse_usuarios
      ORDER BY nombre
    `);

    res.json({
      ok: true,
      data: r.rows
    });

  } catch (err) {
    console.error('get usuarios:', err);
    res.status(500).json({
      ok: false,
      error: 'Error interno del servidor'
    });
  }
});

// ------------------------------------------------------------
// cambio password protegido
// ------------------------------------------------------------
router.put('/usuarios/:id/password', requireAdminKey, async (req, res) => {
  try {
    const errPass = validarPassword(req.body.password);

    if (errPass) {
      return res.status(400).json({
        ok: false,
        error: errPass
      });
    }

    const hash = await bcrypt.hash(req.body.password, 10);

    await pool.query(
      `UPDATE inhouse_usuarios
       SET password_hash = $1
       WHERE id = $2`,
      [hash, req.params.id]
    );

    res.json({
      ok: true,
      mensaje: 'Contraseña actualizada'
    });

  } catch (err) {
    console.error('update password:', err);
    res.status(500).json({
      ok: false,
      error: 'Error interno del servidor'
    });
  }
});

// ------------------------------------------------------------
// activar/desactivar protegido
// ------------------------------------------------------------
router.put('/usuarios/:id', requireAdminKey, async (req, res) => {
  try {
    const { activo } = req.body;

    const r = await pool.query(
      `UPDATE inhouse_usuarios
       SET activo = $1
       WHERE id = $2
       RETURNING id, nombre, activo`,
      [activo, req.params.id]
    );

    if (!r.rows.length) {
      return res.status(404).json({
        ok: false,
        error: 'No encontrado'
      });
    }

    res.json({
      ok: true,
      data: r.rows[0]
    });

  } catch (err) {
    console.error('toggle usuario:', err);
    res.status(500).json({
      ok: false,
      error: 'Error interno del servidor'
    });
  }
});

module.exports = router;
