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
    const { guardia_id, turno_id, punto_id, fecha, nota_excepcion, es_cobertura } = req.body;
    if (!guardia_id || !turno_id || !punto_id || !fecha) {
      return res.status(400).json({ success: false, error: 'guardia_id, turno_id, punto_id y fecha son requeridos' });
    }

    // ── Cargar turno actual para saber hora_inicio/hora_fin ──
    const turnoResult = await pool.query('SELECT * FROM seguridad_turnos WHERE id = $1', [turno_id]);
    if (!turnoResult.rows.length) return res.status(400).json({ success: false, error: 'Turno no válido' });
    const turno = turnoResult.rows[0];

    // ── Verificar asignaciones existentes del guardia ──
    const asigExistentes = await pool.query(
      `SELECT c.*, t.hora_inicio, t.hora_fin, t.nombre AS turno_nombre, p.nombre AS punto_nombre
       FROM seguridad_calendario c
       JOIN seguridad_turnos t ON t.id = c.turno_id
       JOIN seguridad_puntos p ON p.id = c.punto_id
       WHERE c.guardia_id = $1
       AND c.fecha BETWEEN ($2::date - interval '1 day') AND ($2::date + interval '1 day')`,
      [guardia_id, fecha]
    );

    const advertencias = [];

    for (const asig of asigExistentes.rows) {
      const mismaFecha = asig.fecha.toISOString().startsWith(fecha);

      // Regla 1: mismo día, punto distinto
      if (mismaFecha && asig.punto_id !== parseInt(punto_id)) {
        advertencias.push(`El guardia ya está asignado en ${asig.punto_nombre} el mismo día`);
      }

      // Regla 2: turno consecutivo mismo día
      if (mismaFecha) {
        const horaFinAsig = asig.hora_fin;
        const horaInicioNuevo = turno.hora_inicio;
        const horaFinNuevo = turno.hora_fin;
        const horaInicioAsig = asig.hora_inicio;
        if (horaFinAsig === horaInicioNuevo || horaFinNuevo === horaInicioAsig) {
          advertencias.push(`Turno consecutivo: ${asig.turno_nombre} y ${turno.nombre} en el mismo día (${Math.abs(16)} hrs seguidas)`);
        }
      }

      // Regla 3: turno consecutivo entre días (nocturno anterior + matutino siguiente)
      const fechaAsig = new Date(asig.fecha);
      const fechaNueva = new Date(fecha);
      const diffDias = Math.round((fechaNueva - fechaAsig) / (1000 * 60 * 60 * 24));
      if (Math.abs(diffDias) === 1) {
        // Nocturno termina a las 06:00 del día siguiente
        const esNocturnoAnterior = asig.hora_inicio === '22:00:00' && diffDias === 1;
        const esMatutinoSiguiente = turno.hora_inicio === '06:00:00' && diffDias === 1;
        const esNocturnoNuevo = turno.hora_inicio === '22:00:00' && diffDias === -1;
        const esMatutinoAnterior = asig.hora_inicio === '06:00:00' && diffDias === -1;
        if ((esNocturnoAnterior && esMatutinoSiguiente) || (esNocturnoNuevo && esMatutinoAnterior)) {
          advertencias.push(`Turno consecutivo entre días: nocturno y matutino con menos de 8 horas de descanso`);
        }
      }
    }

    // Regla 4: más de 6 días consecutivos
    const semanaResult = await pool.query(
      `SELECT COUNT(DISTINCT fecha) as dias
       FROM seguridad_calendario
       WHERE guardia_id = $1
       AND fecha BETWEEN ($2::date - interval '6 days') AND $2::date`,
      [guardia_id, fecha]
    );
    if (parseInt(semanaResult.rows[0].dias) >= 6) {
      advertencias.push('El guardia llevaría 7 o más días consecutivos trabajando sin descanso');
    }

    // Si hay advertencias y no viene nota_excepcion, devolver advertencias para que el frontend las muestre
    if (advertencias.length > 0 && !nota_excepcion) {
      return res.status(409).json({
        success: false,
        advertencias,
        requiere_nota: true,
        error: 'Se detectaron conflictos de asignación'
      });
    }

    // Guardar asignación
    const result = await pool.query(
      `INSERT INTO seguridad_calendario (guardia_id, turno_id, punto_id, fecha, created_by, nota_excepcion, es_cobertura)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (guardia_id, fecha, turno_id) DO UPDATE
         SET punto_id = EXCLUDED.punto_id,
             created_by = EXCLUDED.created_by,
             nota_excepcion = EXCLUDED.nota_excepcion,
             es_cobertura = EXCLUDED.es_cobertura
       RETURNING *`,
      [guardia_id, turno_id, punto_id, fecha, req.user.id, nota_excepcion || null, es_cobertura || false]
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
