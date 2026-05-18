// ============================================================
// routes-inhouse.js — Módulo Inhouse, Paraíso del Mar
// ============================================================
const express = require('express');
const router  = express.Router();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── Helpers ─────────────────────────────────────────────────
function extraerEdificio(unidad) {
  if (!unidad) return 'X';
  const u = unidad.trim().toUpperCase();
  if (u.startsWith('CASA') || /^\d/.test(u)) return 'Casa';
  return u[0];
}

// ── 1. GET /api/inhouse — lista con filtros ─────────────────
router.get('/', async (req, res) => {
  try {
    const { estado, edificio, tipo, pm, q, limit = 100, offset = 0 } = req.query;

    let where = [];
    const params = [];
    let p = 1;

    if (estado === 'activo') {
      where.push(`fecha_ingreso <= CURRENT_DATE AND (fecha_salida IS NULL OR fecha_salida >= CURRENT_DATE)`);
    } else if (estado === 'futuro') {
      where.push(`fecha_ingreso > CURRENT_DATE`);
    } else if (estado === 'salida') {
      where.push(`fecha_salida < CURRENT_DATE`);
    }

    if (edificio) { where.push(`r.edificio = $${p++}`); params.push(edificio); }
    if (tipo)     { where.push(`r.tipo = $${p++}`);     params.push(tipo); }
    if (pm)       { where.push(`r.property_manager_id = $${p++}`); params.push(parseInt(pm)); }
    if (q)        {
      where.push(`(r.nombre_huesped ILIKE $${p} OR r.unidad ILIKE $${p})`);
      params.push(`%${q}%`); p++;
    }

    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const sql = `
      SELECT
        r.id, r.unidad, r.edificio, r.tipo,
        r.nombre_huesped, r.email, r.telefono,
        r.fecha_ingreso, r.fecha_salida, r.num_personas,
        r.notas, r.created_at, r.pdf_firmado_url,
        pm.nombre AS property_manager,
        CASE
          WHEN r.fecha_ingreso > CURRENT_DATE THEN 'futuro'
          WHEN r.fecha_salida IS NULL OR r.fecha_salida >= CURRENT_DATE THEN 'activo'
          ELSE 'salida'
        END AS estado,
        (CURRENT_DATE - r.fecha_ingreso) AS noches_transcurridas,
        (r.fecha_salida - CURRENT_DATE) AS noches_restantes,
        COALESCE(
          (SELECT json_agg(a.nombre ORDER BY a.orden)
           FROM inhouse_acompanantes a WHERE a.registro_id = r.id),
          '[]'
        ) AS acompanantes
      FROM inhouse_registros r
      LEFT JOIN inhouse_property_managers pm ON pm.id = r.property_manager_id
      ${whereStr}
      ORDER BY r.fecha_ingreso DESC
      LIMIT $${p} OFFSET $${p+1}
    `;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(sql, params);
    res.json({ ok: true, data: result.rows, total: result.rowCount });
  } catch (err) {
    console.error('GET /inhouse:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 2. GET /api/inhouse/ocupacion ───────────────────────────
router.get('/ocupacion', async (req, res) => {
  try {
    const hoy = await pool.query(`
      SELECT
        edificio,
        COUNT(*) FILTER (WHERE tipo = 'H') AS homeowners,
        COUNT(*) FILTER (WHERE tipo = 'R') AS renters,
        COUNT(*) FILTER (WHERE tipo = 'G') AS guests,
        SUM(num_personas) AS personas_total
      FROM inhouse_registros
      WHERE fecha_ingreso <= CURRENT_DATE
        AND (fecha_salida IS NULL OR fecha_salida >= CURRENT_DATE)
      GROUP BY edificio
      ORDER BY edificio
    `);

    const totales = await pool.query(`
      SELECT
        COUNT(*) AS registros_activos,
        SUM(num_personas) AS personas_activas,
        COUNT(*) FILTER (WHERE fecha_ingreso = CURRENT_DATE) AS check_in_hoy,
        COUNT(*) FILTER (WHERE fecha_salida  = CURRENT_DATE) AS check_out_hoy,
        COUNT(*) FILTER (WHERE fecha_ingreso > CURRENT_DATE) AS futuros
      FROM inhouse_registros
      WHERE (fecha_salida IS NULL OR fecha_salida >= CURRENT_DATE)
    `);

    res.json({ ok: true, por_edificio: hoy.rows, totales: totales.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 3. GET /api/inhouse/hoy ─────────────────────────────────
router.get('/hoy', async (req, res) => {
  try {
    const [ins, outs] = await Promise.all([
      pool.query(`
        SELECT r.*, pm.nombre AS property_manager
        FROM inhouse_registros r
        LEFT JOIN inhouse_property_managers pm ON pm.id = r.property_manager_id
        WHERE r.fecha_ingreso = CURRENT_DATE ORDER BY r.unidad
      `),
      pool.query(`
        SELECT r.*, pm.nombre AS property_manager
        FROM inhouse_registros r
        LEFT JOIN inhouse_property_managers pm ON pm.id = r.property_manager_id
        WHERE r.fecha_salida = CURRENT_DATE ORDER BY r.unidad
      `)
    ]);
    res.json({ ok: true, check_ins: ins.rows, check_outs: outs.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 4. GET /api/inhouse/managers — lista todos los PMs ──────
router.get('/managers', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM inhouse_property_managers ORDER BY nombre`
    );
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 4b. POST /api/inhouse/managers — nuevo PM ───────────────
router.post('/managers', async (req, res) => {
  try {
    const { nombre, email, telefono } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ ok: false, error: 'El nombre es requerido' });
    }
    const r = await pool.query(
      `INSERT INTO inhouse_property_managers (nombre, email, telefono)
       VALUES ($1, $2, $3) RETURNING *`,
      [nombre.trim(), email || null, telefono || null]
    );
    res.status(201).json({ ok: true, data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 4c. PUT /api/inhouse/managers/:id — editar/activar PM ───
router.put('/managers/:id', async (req, res) => {
  try {
    const { nombre, email, telefono, activo } = req.body;
    const r = await pool.query(
      `UPDATE inhouse_property_managers SET
        nombre   = COALESCE($1, nombre),
        email    = COALESCE($2, email),
        telefono = COALESCE($3, telefono),
        activo   = COALESCE($4, activo)
       WHERE id = $5 RETURNING *`,
      [nombre || null, email || null, telefono || null,
       activo !== undefined ? activo : null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'No encontrado' });
    res.json({ ok: true, data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 5. GET /api/inhouse/:id — detalle completo ──────────────
router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT r.*, pm.nombre AS property_manager,
        COALESCE(
          (SELECT json_agg(a ORDER BY a.orden)
           FROM inhouse_acompanantes a WHERE a.registro_id = r.id),
          '[]'
        ) AS acompanantes
      FROM inhouse_registros r
      LEFT JOIN inhouse_property_managers pm ON pm.id = r.property_manager_id
      WHERE r.id = $1
    `, [req.params.id]);

    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'No encontrado' });
    res.json({ ok: true, data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 6. POST /api/inhouse — nuevo registro ───────────────────
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      unidad, tipo = 'R', property_manager_id,
      nombre_huesped, email, telefono, direccion,
      fecha_ingreso, fecha_salida, num_personas,
      interesado_comprar = false, recibir_info = false,
      acompanantes = [],
      pdf_firmado_url, firma_imagen,
      notas, registrado_por
    } = req.body;

    if (!unidad || !nombre_huesped || !fecha_ingreso) {
      return res.status(400).json({ ok: false, error: 'unidad, nombre_huesped y fecha_ingreso son requeridos' });
    }

    const edificio = extraerEdificio(unidad);
    await client.query('BEGIN');

    const ins = await client.query(`
      INSERT INTO inhouse_registros
        (unidad, edificio, tipo, property_manager_id,
         nombre_huesped, email, telefono, direccion,
         fecha_ingreso, fecha_salida, num_personas,
         interesado_comprar, recibir_info,
         pdf_firmado_url, firma_imagen, notas, registrado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *
    `, [unidad, edificio, tipo, property_manager_id || null,
        nombre_huesped, email || null, telefono || null, direccion || null,
        fecha_ingreso, fecha_salida || null, num_personas,
        interesado_comprar, recibir_info,
        pdf_firmado_url || null, firma_imagen || null,
        notas || null, registrado_por || null]);

    const registro = ins.rows[0];

    if (acompanantes.length > 0) {
      const vals = acompanantes
        .filter(n => n && n.trim())
        .map((nombre, i) => `('${registro.id}', '${nombre.replace(/'/g, "''")}', ${i + 1})`);
      if (vals.length > 0) {
        await client.query(`
          INSERT INTO inhouse_acompanantes (registro_id, nombre, orden)
          VALUES ${vals.join(',')}
        `);
      }
    }

    await client.query('COMMIT');

    if (req.app.get('io')) {
      req.app.get('io').emit('inhouse:nuevo', { registro: registro.id, unidad, nombre_huesped });
    }

    res.status(201).json({ ok: true, data: registro });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /inhouse:', err);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// ── 7. PUT /api/inhouse/:id — editar registro ───────────────
router.put('/:id', async (req, res) => {
  try {
    const {
      unidad, tipo, property_manager_id,
      nombre_huesped, email, telefono, direccion,
      fecha_ingreso, fecha_salida, num_personas,
      interesado_comprar, recibir_info, notas
    } = req.body;

    const edificio = unidad ? extraerEdificio(unidad) : undefined;

    const r = await pool.query(`
      UPDATE inhouse_registros SET
        unidad              = COALESCE($1,  unidad),
        edificio            = COALESCE($2,  edificio),
        tipo                = COALESCE($3,  tipo),
        property_manager_id = COALESCE($4,  property_manager_id),
        nombre_huesped      = COALESCE($5,  nombre_huesped),
        email               = COALESCE($6,  email),
        telefono            = COALESCE($7,  telefono),
        direccion           = COALESCE($8,  direccion),
        fecha_ingreso       = COALESCE($9,  fecha_ingreso),
        fecha_salida        = COALESCE($10, fecha_salida),
        num_personas        = COALESCE($11, num_personas),
        interesado_comprar  = COALESCE($12, interesado_comprar),
        recibir_info        = COALESCE($13, recibir_info),
        notas               = COALESCE($14, notas)
      WHERE id = $15
      RETURNING *
    `, [unidad, edificio, tipo, property_manager_id,
        nombre_huesped, email, telefono, direccion,
        fecha_ingreso, fecha_salida, num_personas,
        interesado_comprar, recibir_info, notas,
        req.params.id]);

    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'No encontrado' });
    res.json({ ok: true, data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 8. DELETE /api/inhouse/:id — eliminar registro ──────────
router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM inhouse_registros WHERE id = $1 RETURNING id`, [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'No encontrado' });
    res.json({ ok: true, deleted: req.params.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
