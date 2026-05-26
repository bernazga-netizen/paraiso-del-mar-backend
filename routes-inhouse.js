// ============================================================
// routes-inhouse.js — Módulo Inhouse, Paraíso del Mar
// ============================================================
const express  = require('express');
const router   = express.Router();
const { Pool } = require('pg');
const { verifyToken } = require('./middlewares/auth');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── PÚBLICO: no requiere token ───────────────────────────────
router.get('/managers', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, nombre, activo FROM inhouse_property_managers ORDER BY nombre'
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 7. POST /api/inhouse — nuevo registro (público: formulario de huéspedes) ─
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

    // ── SEGURIDAD: validaciones de entrada ──────────────────
    if (!unidad || !nombre_huesped || !fecha_ingreso) {
      return res.status(400).json({ ok: false, error: 'unidad, nombre_huesped y fecha_ingreso son requeridos' });
    }
    if (!TIPOS_VALIDOS.includes(tipo)) {
      return res.status(400).json({ ok: false, error: 'Tipo de ocupación no válido' });
    }
    if (nombre_huesped.length > 300) {
      return res.status(400).json({ ok: false, error: 'Nombre demasiado largo' });
    }
    if (unidad.length > 50) {
      return res.status(400).json({ ok: false, error: 'Unidad inválida' });
    }

    const traslape = await verificarTraslape(unidad, fecha_ingreso, fecha_salida);
    if (traslape) {
      const fi = traslape.fecha_ingreso.toString().substring(0, 10);
      const fs = traslape.fecha_salida ? traslape.fecha_salida.toString().substring(0, 10) : 'sin fecha de salida';
      return res.status(409).json({
        ok: false,
        error: `La unidad ${unidad} ya tiene un registro en esas fechas`,
        detalle: `Registro existente: ${traslape.nombre_huesped} · ${fi} → ${fs}`,
        codigo: 'TRASLAPE_FECHAS'
      });
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

    // ── SEGURIDAD: acompañantes con query parametrizada ─────
    const acompsLimpios = acompanantes
      .filter(n => n && typeof n === 'string' && n.trim())
      .slice(0, 8)
      .map(n => n.trim().substring(0, 200));

    for (let i = 0; i < acompsLimpios.length; i++) {
      await client.query(
        `INSERT INTO inhouse_acompanantes (registro_id, nombre, orden) VALUES ($1, $2, $3)`,
        [registro.id, acompsLimpios[i], i + 1]
      );
    }

    await guardarHistorial(client, {
      registro_id:    registro.id,
      usuario_nombre: registrado_por || 'Sistema',
      accion:         'crear',
      campo:          null,
      valor_antes:    null,
      valor_despues:  `${unidad} · ${nombre_huesped}`
    });

    await client.query('COMMIT');

    try {
      const unidadLabel = registro.edificio && registro.edificio !== 'Casa'
        ? 'Edificio ' + registro.edificio + ' · Unidad ' + registro.unidad
        : 'Casa ' + registro.unidad;
      const tipoMap = { H: 'Propietario', R: 'Renta', G: 'Invitado', P: 'Personal' };
      const tipoTexto = tipoMap[registro.tipo] || registro.tipo;
      const fechaIn = registro.fecha_ingreso
        ? new Date(registro.fecha_ingreso).toLocaleDateString('es-MX', { timeZone: 'America/Mazatlan', day: '2-digit', month: 'long', year: 'numeric' })
        : '—';
      const fechaOut = registro.fecha_salida
        ? new Date(registro.fecha_salida).toLocaleDateString('es-MX', { timeZone: 'America/Mazatlan', day: '2-digit', month: 'long', year: 'numeric' })
        : 'Por definir';
      await resend.emails.send({
        from: 'onboarding@resend.dev',
        to: 'hoapdm@gmail.com',
        subject: 'Inhouse: ' + unidadLabel,
        html: '<div style="font-family:Verdana,Geneva,sans-serif;background:#f2efec;padding:32px;"><div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #c2d8dd;border-radius:4px;overflow:hidden;"><div style="background:#003660;padding:20px 28px;"><p style="margin:0;font-size:15px;font-weight:bold;color:#ffffff;letter-spacing:2px;">Paraíso del Mar</p><p style="margin:4px 0 0;font-size:10px;color:#71aeb7;">Nuevo registro Inhouse</p></div><div style="height:3px;background:linear-gradient(90deg,#007c89,#71aeb7);"></div><div style="padding:28px;"><table style="width:100%;border-collapse:collapse;font-size:13px;"><tr><td style="padding:8px 0;color:#3d5a66;width:38%;border-bottom:1px solid #e8f4f6;">Unidad</td><td style="padding:8px 0;color:#1a2e3a;font-weight:bold;border-bottom:1px solid #e8f4f6;">' + unidadLabel + '</td></tr><tr><td style="padding:8px 0;color:#3d5a66;border-bottom:1px solid #e8f4f6;">Huésped</td><td style="padding:8px 0;color:#1a2e3a;font-weight:bold;border-bottom:1px solid #e8f4f6;">' + registro.nombre_huesped + '</td></tr><tr><td style="padding:8px 0;color:#3d5a66;border-bottom:1px solid #e8f4f6;">Tipo</td><td style="padding:8px 0;color:#1a2e3a;border-bottom:1px solid #e8f4f6;">' + tipoTexto + '</td></tr><tr><td style="padding:8px 0;color:#3d5a66;border-bottom:1px solid #e8f4f6;">Check-in</td><td style="padding:8px 0;color:#1a2e3a;border-bottom:1px solid #e8f4f6;">' + fechaIn + '</td></tr><tr><td style="padding:8px 0;color:#3d5a66;border-bottom:1px solid #e8f4f6;">Check-out</td><td style="padding:8px 0;color:#1a2e3a;border-bottom:1px solid #e8f4f6;">' + fechaOut + '</td></tr><tr><td style="padding:8px 0;color:#3d5a66;border-bottom:1px solid #e8f4f6;">Correo</td><td style="padding:8px 0;color:#1a2e3a;border-bottom:1px solid #e8f4f6;">' + (registro.email || '—') + '</td></tr><tr><td style="padding:8px 0;color:#3d5a66;">Teléfono</td><td style="padding:8px 0;color:#1a2e3a;">' + (registro.telefono || '—') + '</td></tr></table></div><div style="background:#003660;padding:12px 28px;text-align:center;"><p style="margin:0;font-size:10px;color:#71aeb7;">Paraíso del Mar · La Paz, BCS · Sistema de Gestión</p></div></div></div>'
      });
    } catch (emailErr) {
      console.error('Error al enviar notificacion por correo:', emailErr.message);
    }

    if (req.app.get('io')) {
      req.app.get('io').emit('inhouse:nuevo', { registro: registro.id, unidad, nombre_huesped });
    }

    res.status(201).json({ ok: true, data: registro });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /inhouse:', err);
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

router.use(verifyToken);

// ── SEGURIDAD: tipos válidos de ocupación ───────────────────
const TIPOS_VALIDOS = ['H', 'R', 'G', 'P'];

// ── Helpers ─────────────────────────────────────────────────
function extraerEdificio(unidad) {
  if (!unidad) return 'X';
  const u = unidad.trim().toUpperCase();
  if (u.startsWith('CASA') || /^\d/.test(u)) return 'Casa';
  return u[0];
}

async function verificarTraslape(unidad, fecha_ingreso, fecha_salida, excludeId = null) {
  const fechaSalidaEfectiva = fecha_salida || '2099-12-31';
  const params = [unidad.trim().toUpperCase(), fecha_ingreso, fechaSalidaEfectiva];
  let excludeClause = '';
  if (excludeId) {
    params.push(excludeId);
    excludeClause = `AND id != $${params.length}`;
  }
  const result = await pool.query(`
    SELECT id, nombre_huesped, fecha_ingreso, fecha_salida
    FROM inhouse_registros
    WHERE UPPER(unidad) = $1
      AND fecha_ingreso < $3
      AND (fecha_salida IS NULL OR fecha_salida > $2)
      ${excludeClause}
    LIMIT 1
  `, params);
  return result.rows[0] || null;
}

async function guardarHistorial(client, { registro_id, usuario_id, usuario_nombre, accion, campo, valor_antes, valor_despues }) {
  await client.query(`
    INSERT INTO inhouse_historial
      (registro_id, usuario_id, usuario_nombre, accion, campo, valor_antes, valor_despues)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [registro_id, usuario_id || null, usuario_nombre || 'Sistema', accion, campo || null, valor_antes || null, valor_despues || null]);
}

const CAMPOS_AUDITABLES = {
  unidad:              'Unidad',
  tipo:                'Tipo',
  nombre_huesped:      'Nombre del huésped',
  email:               'Email',
  telefono:            'Teléfono',
  direccion:           'Dirección',
  fecha_ingreso:       'Check in',
  fecha_salida:        'Check out',
  num_personas:        'Número de personas',
  property_manager_id: 'Property Manager',
  notas:               'Notas',
};

// ── 1. GET /api/inhouse — lista con filtros ─────────────────
router.get('/', async (req, res) => {
  try {
    const { estado, edificio, tipo, pm, q, fecha_inicio, fecha_fin, limit = 100, offset = 0 } = req.query;

    let where = [];
    const params = [];
    let p = 1;

    if (!fecha_inicio && !fecha_fin) {
      if (estado === 'activo') {
        where.push(`r.fecha_ingreso <= CURRENT_DATE AND (r.fecha_salida IS NULL OR r.fecha_salida >= CURRENT_DATE)`);
      } else if (estado === 'futuro') {
        where.push(`r.fecha_ingreso > CURRENT_DATE`);
      } else if (estado === 'salida') {
        where.push(`r.fecha_salida < CURRENT_DATE`);
      }
    }

    if (fecha_inicio) { where.push(`(r.fecha_salida IS NULL OR r.fecha_salida >= $${p++})`); params.push(fecha_inicio); }
    if (fecha_fin)    { where.push(`r.fecha_ingreso <= $${p++}`); params.push(fecha_fin); }

    if (edificio) { where.push(`r.edificio = $${p++}`);            params.push(edificio); }
    if (tipo && TIPOS_VALIDOS.includes(tipo)) { where.push(`r.tipo = $${p++}`); params.push(tipo); }
    if (pm)       { where.push(`r.property_manager_id = $${p++}`); params.push(parseInt(pm)); }
    if (q)        { where.push(`(r.nombre_huesped ILIKE $${p} OR r.unidad ILIKE $${p})`); params.push(`%${q}%`); p++; }

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
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ── 2. GET /api/inhouse/ocupacion ───────────────────────────
router.get('/ocupacion', async (req, res) => {
  try {
    const [hoy, totales, porTipoHoy] = await Promise.all([
      pool.query(`
        SELECT edificio,
          COUNT(*) FILTER (WHERE tipo = 'H') AS homeowners,
          COUNT(*) FILTER (WHERE tipo = 'R') AS renters,
          COUNT(*) FILTER (WHERE tipo = 'G') AS guests,
          SUM(num_personas) AS personas_total
        FROM inhouse_registros
        WHERE fecha_ingreso <= CURRENT_DATE
          AND (fecha_salida IS NULL OR fecha_salida >= CURRENT_DATE)
        GROUP BY edificio ORDER BY edificio
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (
            WHERE fecha_ingreso <= CURRENT_DATE
              AND (fecha_salida IS NULL OR fecha_salida >= CURRENT_DATE)
          ) AS registros_activos,
          SUM(num_personas) FILTER (
            WHERE fecha_ingreso <= CURRENT_DATE
              AND (fecha_salida IS NULL OR fecha_salida >= CURRENT_DATE)
          ) AS personas_activas,
          COUNT(*) FILTER (WHERE fecha_ingreso = CURRENT_DATE) AS check_in_hoy,
          COUNT(*) FILTER (WHERE fecha_salida  = CURRENT_DATE) AS check_out_hoy,
          COUNT(*) FILTER (WHERE fecha_ingreso > CURRENT_DATE) AS futuros
        FROM inhouse_registros
        WHERE fecha_salida IS NULL OR fecha_salida >= CURRENT_DATE
      `),
      pool.query(`
        SELECT tipo,
          COUNT(*) AS unidades_total,
          COALESCE(SUM(num_personas), 0) AS personas_total
        FROM inhouse_registros
        WHERE fecha_ingreso <= CURRENT_DATE
          AND (fecha_salida IS NULL OR fecha_salida >= CURRENT_DATE)
        GROUP BY tipo ORDER BY tipo
      `)
    ]);
    res.json({ ok: true, por_edificio: hoy.rows, totales: totales.rows[0], por_tipo_hoy: porTipoHoy.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ── 3. GET /api/inhouse/hoy ─────────────────────────────────
router.get('/hoy', async (req, res) => {
  try {
    const [ins, outs] = await Promise.all([
      pool.query(`SELECT r.*, pm.nombre AS property_manager FROM inhouse_registros r LEFT JOIN inhouse_property_managers pm ON pm.id = r.property_manager_id WHERE r.fecha_ingreso = CURRENT_DATE ORDER BY r.unidad`),
      pool.query(`SELECT r.*, pm.nombre AS property_manager FROM inhouse_registros r LEFT JOIN inhouse_property_managers pm ON pm.id = r.property_manager_id WHERE r.fecha_salida = CURRENT_DATE ORDER BY r.unidad`)
    ]);
    res.json({ ok: true, check_ins: ins.rows, check_outs: outs.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ── 4b. POST /api/inhouse/managers ──────────────────────────
router.post('/managers', async (req, res) => {
  try {
    const { nombre, email, telefono } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ ok: false, error: 'El nombre es requerido' });
    }
    const r = await pool.query(
      `INSERT INTO inhouse_property_managers (nombre, email, telefono) VALUES ($1, $2, $3) RETURNING *`,
      [nombre.trim().substring(0, 200), email || null, telefono || null]
    );
    res.status(201).json({ ok: true, data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ── 4c. PUT /api/inhouse/managers/:id ───────────────────────
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
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ── 5. GET /api/inhouse/estadisticas/mensuales ──────────────
router.get('/estadisticas/mensuales', async (req, res) => {
  try {
    const anio = parseInt(req.query.anio) || new Date().getFullYear();

    const [checkins, checkouts, ocupacion] = await Promise.all([
      pool.query(`SELECT EXTRACT(MONTH FROM fecha_ingreso)::int AS mes, COUNT(*) AS total, SUM(num_personas) AS personas FROM inhouse_registros WHERE EXTRACT(YEAR FROM fecha_ingreso) = $1 GROUP BY mes ORDER BY mes`, [anio]),
      pool.query(`SELECT EXTRACT(MONTH FROM fecha_salida)::int AS mes, COUNT(*) AS total, SUM(num_personas) AS personas FROM inhouse_registros WHERE fecha_salida IS NOT NULL AND EXTRACT(YEAR FROM fecha_salida) = $1 GROUP BY mes ORDER BY mes`, [anio]),
      pool.query(`
        SELECT m.mes, COUNT(r.id) AS registros_activos, COALESCE(SUM(r.num_personas), 0) AS personas_total
        FROM generate_series(1, 12) AS m(mes)
        LEFT JOIN inhouse_registros r ON (
          EXTRACT(YEAR FROM r.fecha_ingreso) <= $1
          AND (r.fecha_salida IS NULL OR EXTRACT(YEAR FROM r.fecha_salida) >= $1)
          AND EXTRACT(MONTH FROM r.fecha_ingreso) <= m.mes
          AND (r.fecha_salida IS NULL OR EXTRACT(MONTH FROM r.fecha_salida) >= m.mes)
          AND (EXTRACT(YEAR FROM r.fecha_ingreso) < $1 OR EXTRACT(MONTH FROM r.fecha_ingreso) <= m.mes)
        )
        GROUP BY m.mes ORDER BY m.mes
      `, [anio])
    ]);

    const meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    const data = meses.map((nombre, i) => {
      const mes = i + 1;
      const ci = checkins.rows.find(r => r.mes === mes);
      const co = checkouts.rows.find(r => r.mes === mes);
      const oc = ocupacion.rows.find(r => parseInt(r.mes) === mes);
      return {
        mes: nombre,
        checkins:    ci ? parseInt(ci.total) : 0,
        checkouts:   co ? parseInt(co.total) : 0,
        personas_ci: ci ? parseInt(ci.personas) : 0,
        personas_co: co ? parseInt(co.personas) : 0,
        ocupacion:   oc ? parseInt(oc.registros_activos) : 0,
        personas_oc: oc ? parseInt(oc.personas_total) : 0,
      };
    });

    res.json({ ok: true, anio, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// Historial de ocupación con filtros
router.get('/historial-ocupacion', async (req, res) => {
  try {
    const { unidad, edificio, tipo, desde, hasta } = req.query;

    let conditions = [];
    let values = [];
    let idx = 1;

    if (unidad) {
      conditions.push(`unidad = $${idx++}`);
      values.push(unidad);
    }
    if (edificio) {
      conditions.push(`edificio = $${idx++}`);
      values.push(edificio);
    }
    if (tipo) {
      conditions.push(`tipo = $${idx++}`);
      values.push(tipo);
    }
    if (desde) {
      conditions.push(`fecha_ingreso >= $${idx++}`);
      values.push(desde);
    }
    if (hasta) {
      conditions.push(`fecha_ingreso <= $${idx++}`);
      values.push(hasta);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(`
      SELECT
        r.id,
        r.unidad,
        r.edificio,
        r.tipo,
        r.nombre_huesped,
        r.fecha_ingreso,
        r.fecha_salida,
        (r.fecha_salida - r.fecha_ingreso) AS noches,
        r.num_personas,
        r.property_manager_id,
        pm.nombre AS property_manager_nombre,
        r.registrado_por,
        r.notas,
        r.created_at
      FROM inhouse_registros r
      LEFT JOIN inhouse_property_managers pm ON r.property_manager_id = pm.id
      ${where}
      ORDER BY fecha_ingreso DESC
      LIMIT 500
    `, values);

    res.json({ ok: true, registros: result.rows });
  } catch (err) {
    console.error('Error historial-ocupacion:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 6. GET /api/inhouse/:id ──────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT r.*, pm.nombre AS property_manager,
        COALESCE(
          (SELECT json_agg(a ORDER BY a.orden) FROM inhouse_acompanantes a WHERE a.registro_id = r.id),
          '[]'
        ) AS acompanantes
      FROM inhouse_registros r
      LEFT JOIN inhouse_property_managers pm ON pm.id = r.property_manager_id
      WHERE r.id = $1
    `, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'No encontrado' });
    res.json({ ok: true, data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ── 8. PUT /api/inhouse/:id — editar con historial ──────────
router.put('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      unidad, tipo, property_manager_id,
      nombre_huesped, email, telefono, direccion,
      fecha_ingreso, fecha_salida, num_personas,
      interesado_comprar, recibir_info, notas,
      usuario_id, usuario_nombre
    } = req.body;

    // ── SEGURIDAD: validar tipo si viene en el body ─────────
    if (tipo && !TIPOS_VALIDOS.includes(tipo)) {
      return res.status(400).json({ ok: false, error: 'Tipo de ocupación no válido' });
    }

    if (unidad && fecha_ingreso) {
      const traslape = await verificarTraslape(unidad, fecha_ingreso, fecha_salida, req.params.id);
      if (traslape) {
        const fi = traslape.fecha_ingreso.toString().substring(0, 10);
        const fs = traslape.fecha_salida ? traslape.fecha_salida.toString().substring(0, 10) : 'sin fecha de salida';
        return res.status(409).json({
          ok: false,
          error: `La unidad ${unidad} ya tiene un registro en esas fechas`,
          detalle: `Registro existente: ${traslape.nombre_huesped} · ${fi} → ${fs}`,
          codigo: 'TRASLAPE_FECHAS'
        });
      }
    }

    const anterior = await client.query(`SELECT * FROM inhouse_registros WHERE id = $1`, [req.params.id]);
    if (!anterior.rows.length) return res.status(404).json({ ok: false, error: 'No encontrado' });
    const ant = anterior.rows[0];

    const edificio = unidad ? extraerEdificio(unidad) : undefined;

    await client.query('BEGIN');

    const r = await client.query(`
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

    const nuevo = r.rows[0];

    const camposAComparar = {
      unidad, tipo, property_manager_id, nombre_huesped,
      email, telefono, direccion, fecha_ingreso,
      fecha_salida, num_personas, notas
    };

    for (const [campo, valorNuevo] of Object.entries(camposAComparar)) {
      if (valorNuevo === undefined) continue;
      const valorAntes = ant[campo] !== null && ant[campo] !== undefined
        ? ant[campo].toString().substring(0, 10) === ant[campo].toString()
          ? ant[campo].toString().substring(0, 10)
          : ant[campo].toString()
        : null;
      const valorDespues = valorNuevo !== null ? valorNuevo.toString() : null;
      if (valorAntes !== valorDespues) {
        await guardarHistorial(client, {
          registro_id:    req.params.id,
          usuario_id:     usuario_id || null,
          usuario_nombre: usuario_nombre || 'Administración',
          accion:         'editar',
          campo:          CAMPOS_AUDITABLES[campo] || campo,
          valor_antes:    valorAntes,
          valor_despues:  valorDespues
        });
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true, data: nuevo });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

// ── 9. DELETE /api/inhouse/:id — eliminar con historial ─────
router.delete('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { usuario_id, usuario_nombre } = req.query;

    const ant = await client.query(
      `SELECT unidad, nombre_huesped FROM inhouse_registros WHERE id = $1`,
      [req.params.id]
    );
    if (!ant.rows.length) return res.status(404).json({ ok: false, error: 'No encontrado' });

    const { unidad, nombre_huesped } = ant.rows[0];
    const valorAntes = `${unidad} · ${nombre_huesped}`;

    await client.query('BEGIN');

    await client.query(
      `DELETE FROM inhouse_acompanantes WHERE registro_id = $1`,
      [req.params.id]
    );

    await client.query(
      `DELETE FROM inhouse_registros WHERE id = $1`,
      [req.params.id]
    );

    await client.query(`
      INSERT INTO inhouse_historial
        (registro_id, usuario_id, usuario_nombre, accion, campo, valor_antes, valor_despues)
      VALUES (NULL, $1, $2, 'eliminar', NULL, $3, NULL)
    `, [
      usuario_id || null,
      usuario_nombre || 'Administración',
      valorAntes
    ]);

    await client.query('COMMIT');
    res.json({ ok: true, deleted: req.params.id });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE /inhouse/:id:', err);
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

module.exports = router;
