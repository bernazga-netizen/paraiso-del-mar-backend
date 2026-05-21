// ============================================================
// routes-historial.js — Historial de cambios Inhouse
// Paraíso del Mar
// ============================================================
const express  = require('express');
const router   = express.Router();
const { Pool } = require('pg');
const { verifyToken } = require('./middlewares/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

router.use(verifyToken);

// ── GET /api/historial — lista de cambios con filtros ────────
router.get('/', async (req, res) => {
  try {
    const { registro_id, usuario_id, accion, fecha_inicio, fecha_fin, limit = 200, offset = 0 } = req.query;

    let where = [];
    const params = [];
    let p = 1;

    if (registro_id)  { where.push(`h.registro_id = $${p++}`);   params.push(registro_id); }
    if (usuario_id)   { where.push(`h.usuario_id = $${p++}`);    params.push(parseInt(usuario_id)); }
    if (accion)       { where.push(`h.accion = $${p++}`);        params.push(accion); }
    if (fecha_inicio) { where.push(`h.created_at >= $${p++}`);   params.push(fecha_inicio); }
    if (fecha_fin)    { where.push(`h.created_at <= $${p++}`);   params.push(fecha_fin + ' 23:59:59'); }

    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';

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
      LEFT JOIN inhouse_registros r ON r.id = h.registro_id
      ${whereStr}
      ORDER BY h.created_at DESC
      LIMIT $${p} OFFSET $${p+1}
    `, [...params, parseInt(limit), parseInt(offset)]);

    res.json({ ok: true, data: result.rows, total: result.rowCount });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
