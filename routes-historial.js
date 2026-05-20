// ============================================================
// routes-historial.js — hardening fase 1
// ============================================================
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ------------------------------------------------------------
// middleware admin key temporal
// ------------------------------------------------------------
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
// GET /api/historial
// ------------------------------------------------------------
router.get('/', requireAdminKey, async (req, res) => {
  try {
    const {
      registro_id,
      usuario_id,
      accion,
      fecha_inicio,
      fecha_fin,
      limit = 200,
      offset = 0
    } = req.query;

    const limitNum = Math.min(parseInt(limit) || 200, 500);
    const offsetNum = Math.max(parseInt(offset) || 0, 0);

    let where = [];
    let params = [];
    let p = 1;

    if (registro_id) {
      where.push(`h.registro_id = $${p++}`);
      params.push(registro_id);
    }

    if (usuario_id) {
      where.push(`h.usuario_id = $${p++}`);
      params.push(parseInt(usuario_id));
    }

    if (accion) {
      where.push(`h.accion = $${p++}`);
      params.push(accion);
    }

    if (fecha_inicio) {
      where.push(`h.created_at >= $${p++}`);
      params.push(fecha_inicio);
    }

    if (fecha_fin) {
      where.push(`h.created_at <= $${p++}`);
      params.push(fecha_fin + ' 23:59:59');
    }

    const whereStr = where.length
      ? 'WHERE ' + where.join(' AND ')
      : '';

    const result = await pool.query(`
      SELECT
        h.id,
        h.registro_id,
        h.usuario_nombre,
        h.accion,
        h.campo,
        h.valor_antes,
        h.valor_despues,
        h.created_at,
        r.unidad,
        r.nombre_huesped
      FROM inhouse_historial h
      LEFT JOIN inhouse_registros r
        ON r.id = h.registro_id
      ${whereStr}
      ORDER BY h.created_at DESC
      LIMIT $${p}
      OFFSET $${p + 1}
    `, [...params, limitNum, offsetNum]);

    res.json({
      ok: true,
      data: result.rows,
      total: result.rowCount
    });

  } catch (err) {
    console.error('historial:', err);

    res.status(500).json({
      ok: false,
      error: 'Error interno del servidor'
    });
  }
});

module.exports = router;
