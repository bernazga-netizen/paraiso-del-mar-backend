// routes-seguridad.js — Gestión de guardias, turnos, calendario y reportes
const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const { Pool } = require('pg');
const { verifyToken } = require('./middlewares/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── Middlewares ──────────────────────────────────────────────────────────────

function esAdminOSupervisor(req, res, next) {
  const rol = req.user?.rol;
  if (rol === 'admin' || rol === 'supervisor') return next();
  return res.status(403).json({ success: false, error: 'Acceso restringido a admin y supervisor' });
}

function esAdmin(req, res, next) {
  if (req.user?.rol === 'admin') return next();
  return res.status(403).json({ success: false, error: 'Acceso restringido a administradores' });
}

// ─── GUARDIAS ─────────────────────────────────────────────────────────────────

// GET /api/seguridad/guardias
router.get('/guardias', verifyToken, esAdminOSupervisor, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.nombre, u.rol, u.activo, u.created_at,
              p.nombre AS punto_default
       FROM seguridad_usuarios u
       LEFT JOIN seguridad_puntos p ON p.id = u.punto_default_id
       ORDER BY u.nombre`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// POST /api/seguridad/guardias
router.post('/guardias', verifyToken, esAdminOSupervisor, async (req, res) => {
  try {
    const { nombre, password, rol, punto_default_id } = req.body;

    if (!nombre || !nombre.trim()) return res.status(400).json({ success: false, error: 'El nombre es obligatorio' });
    if (!password || password.length < 6) return res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 6 caracteres' });
    if (!['supervisor', 'guardia'].includes(rol)) return res.status(400).json({ success: false, error: 'Rol inválido' });

    const existe = await pool.query(
      `SELECT id FROM seguridad_usuarios WHERE nombre ILIKE $1`, [nombre.trim()]
    );
    if (existe.rows.length) return res.status(400).json({ success: false, error: 'Ya existe un usuario con ese nombre' });

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO seguridad_usuarios (nombre, password_hash, rol, punto_default_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, nombre, rol, activo, created_at`,
      [nombre.trim(), hash, rol, punto_default_id || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// PUT /api/seguridad/guardias/:id
router.put('/guardias/:id', verifyToken, esAdminOSupervisor, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) return res.status(400).json({ success: false, error: 'ID inválido' });

  try {
    const { nombre, rol, punto_default_id, activo, password } = req.body;

    // No permitir modificar al admin principal
    const target = await pool.query(`SELECT rol FROM seguridad_usuarios WHERE id = $1`, [id]);
    if (!target.rows.length) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    if (target.rows[0].rol === 'admin' && req.user.rol !== 'admin') {
      return res.status(403).json({ success: false, error: 'No puedes modificar al administrador' });
    }

    const updates = [];
    const vals = [];

    if (nombre !== undefined) { vals.push(nombre.trim()); updates.push(`nombre = $${vals.length}`); }
    if (rol !== undefined && ['supervisor', 'guardia'].includes(rol)) { vals.push(rol); updates.push(`rol = $${vals.length}`); }
    if (punto_default_id !== undefined) { vals.push(punto_default_id); updates.push(`punto_default_id = $${vals.length}`); }
    if (activo !== undefined) { vals.push(activo); updates.push(`activo = $${vals.length}`); }
    if (password && password.length >= 6) {
      const hash = await bcrypt.hash(password, 10);
      vals.push(hash);
      updates.push(`password_hash = $${vals.length}`);
    }

    if (!updates.length) return res.status(400).json({ success: false, error: 'No se enviaron campos para actualizar' });

    updates.push(`updated_at = NOW()`);
    vals.push(id);

    const result = await pool.query(
      `UPDATE seguridad_usuarios SET ${updates.join(', ')} WHERE id = $${vals.length}
       RETURNING id, nombre, rol, activo, punto_default_id`,
      vals
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ─── CATÁLOGOS ────────────────────────────────────────────────────────────────

// GET /api/seguridad/turnos
router.get('/turnos', verifyToken, esAdminOSupervisor, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM seguridad_turnos ORDER BY hora_inicio`);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// GET /api/seguridad/puntos
router.get('/puntos', verifyToken, esAdminOSupervisor, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM seguridad_puntos WHERE activo = TRUE ORDER BY nombre`);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ─── CALENDARIO ───────────────────────────────────────────────────────────────

// GET /api/seguridad/calendario?fecha_inicio=YYYY-MM-DD&fecha_fin=YYYY-MM-DD
router.get('/calendario', verifyToken, esAdminOSupervisor, async (req, res) => {
  try {
    const { fecha_inicio, fecha_fin } = req.query;
    if (!fecha_inicio || !fecha_fin) return res.status(400).json({ success: false, error: 'fecha_inicio y fecha_fin son requeridos' });

    const result = await pool.query(
      `SELECT c.id, c.fecha,
              u.id AS guardia_id, u.nombre AS guardia_nombre, u.rol AS guardia_rol,
              t.id AS turno_id, t.nombre AS turno_nombre, t.hora_inicio, t.hora_fin,
              p.id AS punto_id, p.nombre AS punto_nombre
       FROM seguridad_calendario c
       JOIN seguridad_usuarios u ON u.id = c.guardia_id
       JOIN seguridad_turnos t   ON t.id = c.turno_id
       JOIN seguridad_puntos p   ON p.id = c.punto_id
       WHERE c.fecha BETWEEN $1 AND $2
       ORDER BY c.fecha, t.hora_inicio, u.nombre`,
      [fecha_inicio, fecha_fin]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// POST /api/seguridad/calendario
router.post('/calendario', verifyToken, esAdminOSupervisor, async (req, res) => {
  try {
    const { guardia_id, turno_id, punto_id, fecha } = req.body;
    if (!guardia_id || !turno_id || !punto_id || !fecha) {
      return res.status(400).json({ success: false, error: 'guardia_id, turno_id, punto_id y fecha son requeridos' });
    }

    const result = await pool.query(
      `INSERT INTO seguridad_calendario (guardia_id, turno_id, punto_id, fecha, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (guardia_id, fecha, turno_id) DO UPDATE
         SET punto_id = EXCLUDED.punto_id, created_by = EXCLUDED.created_by
       RETURNING *`,
      [guardia_id, turno_id, punto_id, fecha, req.user.id]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// DELETE /api/seguridad/calendario/:id
router.delete('/calendario/:id', verifyToken, esAdminOSupervisor, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) return res.status(400).json({ success: false, error: 'ID inválido' });

  try {
    const result = await pool.query(
      `DELETE FROM seguridad_calendario WHERE id = $1 RETURNING id`, [id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Asignación no encontrada' });
    res.json({ success: true, data: { message: 'Asignación eliminada' } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ─── REPORTES ─────────────────────────────────────────────────────────────────

// GET /api/seguridad/reportes/actividad
router.get('/reportes/actividad', verifyToken, esAdminOSupervisor, async (req, res) => {
  try {
    const { fecha_inicio, fecha_fin, guardia_id, tipo, punto_acceso } = req.query;

    const conds = ['b.deleted_at IS NULL'];
    const vals  = [];

    if (fecha_inicio) { vals.push(fecha_inicio); conds.push(`b.created_at >= $${vals.length}::date`); }
    if (fecha_fin)    { vals.push(fecha_fin);    conds.push(`b.created_at < ($${vals.length}::date + interval '1 day')`); }
    if (guardia_id)   { vals.push(parseInt(guardia_id)); conds.push(`b.guardia_id = $${vals.length}`); }
    if (tipo)         { vals.push(tipo);         conds.push(`b.tipo = $${vals.length}`); }
    if (punto_acceso) { vals.push(punto_acceso); conds.push(`b.punto_acceso = $${vals.length}`); }

    const result = await pool.query(
      `SELECT
         b.id, b.tipo, b.punto_acceso, b.descripcion,
         b.observaciones, b.foto_url, b.created_at,
         u.nombre AS guardia_nombre,
         COUNT(*) OVER() AS total
       FROM bitacoras_registros b
       JOIN seguridad_usuarios u ON u.id = b.guardia_id
       WHERE ${conds.join(' AND ')}
       ORDER BY b.created_at DESC`,
      vals
    );

    // Resumen por guardia
    const resumenResult = await pool.query(
      `SELECT u.nombre AS guardia_nombre, b.tipo, COUNT(*) AS total
       FROM bitacoras_registros b
       JOIN seguridad_usuarios u ON u.id = b.guardia_id
       WHERE ${conds.join(' AND ')}
       GROUP BY u.nombre, b.tipo
       ORDER BY u.nombre, b.tipo`,
      vals
    );

    res.json({
      success: true,
      data: {
        registros: result.rows,
        resumen: resumenResult.rows,
        total: result.rows[0]?.total || 0
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// GET /api/seguridad/reportes/asistencia
router.get('/reportes/asistencia', verifyToken, esAdminOSupervisor, async (req, res) => {
  try {
    const { fecha_inicio, fecha_fin, guardia_id } = req.query;
    if (!fecha_inicio || !fecha_fin) return res.status(400).json({ success: false, error: 'fecha_inicio y fecha_fin son requeridos' });

    const conds = ['c.fecha BETWEEN $1 AND $2'];
    const vals  = [fecha_inicio, fecha_fin];

    if (guardia_id) { vals.push(parseInt(guardia_id)); conds.push(`c.guardia_id = $${vals.length}`); }

    const result = await pool.query(
      `SELECT
         c.fecha,
         u.id AS guardia_id, u.nombre AS guardia_nombre,
         t.nombre AS turno_nombre,
         p.nombre AS punto_nombre,
         a.estado,
         a.primer_registro_at
       FROM seguridad_calendario c
       JOIN seguridad_usuarios u ON u.id = c.guardia_id
       JOIN seguridad_turnos t   ON t.id = c.turno_id
       JOIN seguridad_puntos p   ON p.id = c.punto_id
       LEFT JOIN seguridad_asistencia a ON a.calendario_id = c.id
       WHERE ${conds.join(' AND ')}
       ORDER BY c.fecha, u.nombre`,
      vals
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

module.exports = router;
