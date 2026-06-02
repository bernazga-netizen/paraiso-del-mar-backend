// routes-bitacoras.js
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const ExcelJS = require('exceljs');
const { verifyToken } = require('./middlewares/auth');

// ─── Conexión a BD ────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── Cloudinary ───────────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ─── Multer (memoria, no disco) ───────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB máximo
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Formato de imagen no permitido. Usa JPG, PNG o WEBP.'));
    }
  }
});

// ─── Middlewares locales ──────────────────────────────────────────────────────

// Solo admin
function esAdmin(req, res, next) {
  if (req.usuario && req.usuario.rol === 'admin') return next();
  return res.status(403).json({ success: false, error: 'Acceso restringido a administradores' });
}

// Admin o guardia
function esAdminOGuardia(req, res, next) {
  const u = req.usuario;
  if (!u) return res.status(401).json({ success: false, error: 'No autenticado' });
  if (u.rol === 'admin' || u.es_guardia === true) return next();
  return res.status(403).json({ success: false, error: 'Acceso restringido a guardias y administradores' });
}

// Verifica ventana de 5 minutos para guardias (admin siempre puede)
async function puedeEditar(req, res, next) {
  const u = req.usuario;
  if (u.rol === 'admin') return next();

  try {
    const result = await pool.query(
      'SELECT created_at FROM bitacoras_registros WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Registro no encontrado' });
    }
    const creado = new Date(result.rows[0].created_at);
    const ahora = new Date();
    const segundos = (ahora - creado) / 1000;
    if (segundos > 300) {
      return res.status(403).json({
        success: false,
        error: 'El tiempo límite de edición ha expirado (5 minutos)'
      });
    }
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TIPOS_VALIDOS        = ['ronda', 'incidente', 'entrega_turno', 'novedad', 'otro'];
const PUNTOS_VALIDOS       = ['muelle', 'base4', 'base1', 'general'];
const FOTO_URL_PREFIJO     = 'https://res.cloudinary.com/';
const FIRMA_MAX_BYTES      = 200 * 1024; // 200KB en base64 ≈ 273KB de string — usamos bytes del string

function validarBase64Size(b64string) {
  // Cada carácter base64 = 1 byte de string; 200KB = 204800 bytes
  return Buffer.byteLength(b64string, 'utf8') <= FIRMA_MAX_BYTES;
}

// Registra un evento en bitacoras_auditoria
async function registrarAuditoria(client, { bitacora_id, usuario_id, usuario_nombre, accion, campo_modificado, valor_anterior, valor_nuevo, motivo, tenant_id }) {
  await client.query(
    `INSERT INTO bitacoras_auditoria
       (tenant_id, bitacora_id, usuario_id, usuario_nombre, accion, campo_modificado, valor_anterior, valor_nuevo, motivo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [tenant_id || 1, bitacora_id, usuario_id, usuario_nombre, accion, campo_modificado || null, valor_anterior || null, valor_nuevo || null, motivo || null]
  );
}

// Construye WHERE dinámico para filtros comunes
function buildFiltros(query, params, baseWhere) {
  const conds = [...baseWhere]; // ya incluye deleted_at IS NULL
  const vals  = [...params];

  if (query.guardia_id) {
    vals.push(parseInt(query.guardia_id));
    conds.push(`b.guardia_id = $${vals.length}`);
  }
  if (query.tipo && TIPOS_VALIDOS.includes(query.tipo)) {
    vals.push(query.tipo);
    conds.push(`b.tipo = $${vals.length}`);
  }
  if (query.punto_acceso && PUNTOS_VALIDOS.includes(query.punto_acceso)) {
    vals.push(query.punto_acceso);
    conds.push(`b.punto_acceso = $${vals.length}`);
  }
  if (query.fecha_inicio) {
    vals.push(query.fecha_inicio);
    conds.push(`b.created_at >= $${vals.length}::date`);
  }
  if (query.fecha_fin) {
    vals.push(query.fecha_fin);
    conds.push(`b.created_at < ($${vals.length}::date + interval '1 day')`);
  }

  return { conds, vals };
}

// ─── RUTAS ESTÁTICAS (deben ir ANTES de /:id) ────────────────────────────────

// POST /api/bitacoras/upload-foto
router.post('/upload-foto', verifyToken, esAdminOGuardia, upload.single('foto'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No se recibió ninguna imagen' });
    }

    // Subir a Cloudinary desde buffer en memoria
    const resultado = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'bitacoras', resource_type: 'image' },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    res.json({ success: true, data: { foto_url: resultado.secure_url } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Error al subir la imagen' });
  }
});

// GET /api/bitacoras/export
router.get('/export', verifyToken, esAdmin, async (req, res) => {
  try {
    const base = ['b.deleted_at IS NULL'];
    const { conds, vals } = buildFiltros(req.query, [], base);

    const sql = `
      SELECT
        b.id,
        b.created_at,
        u.nombre AS guardia_nombre,
        b.tipo,
        b.punto_acceso,
        b.descripcion,
        b.observaciones,
        b.foto_url
      FROM bitacoras_registros b
      JOIN inhouse_usuarios u ON u.id = b.guardia_id
      WHERE ${conds.join(' AND ')}
      ORDER BY b.created_at DESC
    `;

    const result = await pool.query(sql, vals);

    const workbook  = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Bitácoras');

    worksheet.columns = [
      { header: 'ID',              key: 'id',             width: 8  },
      { header: 'Fecha',           key: 'fecha',          width: 14 },
      { header: 'Hora',            key: 'hora',           width: 10 },
      { header: 'Guardia',         key: 'guardia_nombre', width: 22 },
      { header: 'Tipo',            key: 'tipo',           width: 16 },
      { header: 'Punto de Acceso', key: 'punto_acceso',   width: 18 },
      { header: 'Descripción',     key: 'descripcion',    width: 40 },
      { header: 'Observaciones',   key: 'observaciones',  width: 30 },
      { header: 'Foto',            key: 'foto_url',       width: 50 }
    ];

    // Estilo de encabezado
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern', pattern: 'solid',
      fgColor: { argb: 'FF007C89' }
    };
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    result.rows.forEach(row => {
      const fecha = new Date(row.created_at);
      worksheet.addRow({
        id:             row.id,
        fecha:          fecha.toLocaleDateString('es-MX'),
        hora:           fecha.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }),
        guardia_nombre: row.guardia_nombre,
        tipo:           row.tipo,
        punto_acceso:   row.punto_acceso,
        descripcion:    row.descripcion,
        observaciones:  row.observaciones || '',
        foto_url:       row.foto_url || ''
      });
    });

    const fecha_hoy = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="bitacoras-${fecha_hoy}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Error al generar el Excel' });
  }
});

// GET /api/bitacoras/auditoria  (global)
router.get('/auditoria', verifyToken, esAdmin, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const conds = [];
    const vals  = [];

    if (req.query.usuario_id) {
      vals.push(parseInt(req.query.usuario_id));
      conds.push(`a.usuario_id = $${vals.length}`);
    }
    if (req.query.accion && ['crear','editar','eliminar'].includes(req.query.accion)) {
      vals.push(req.query.accion);
      conds.push(`a.accion = $${vals.length}`);
    }
    if (req.query.fecha_inicio) {
      vals.push(req.query.fecha_inicio);
      conds.push(`a.created_at >= $${vals.length}::date`);
    }
    if (req.query.fecha_fin) {
      vals.push(req.query.fecha_fin);
      conds.push(`a.created_at < ($${vals.length}::date + interval '1 day')`);
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM bitacoras_auditoria a ${where}`,
      vals
    );
    const total = parseInt(countResult.rows[0].count);

    vals.push(limit);
    vals.push(offset);
    const dataResult = await pool.query(
      `SELECT
         a.id, a.bitacora_id, a.accion, a.campo_modificado,
         a.valor_anterior, a.valor_nuevo, a.motivo,
         a.usuario_nombre, a.created_at
       FROM bitacoras_auditoria a
       ${where}
       ORDER BY a.created_at DESC
       LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
      vals
    );

    res.json({
      success: true,
      data: {
        registros: dataResult.rows,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ─── POST /api/bitacoras ─────────────────────────────────────────────────────
router.post('/', verifyToken, esAdminOGuardia, async (req, res) => {
  const {
    tipo, punto_acceso, descripcion, observaciones,
    foto_url, firma_saliente, firma_entrante, guardia_entrante_id
  } = req.body;

  // Validaciones
  if (!tipo || !TIPOS_VALIDOS.includes(tipo)) {
    return res.status(400).json({ success: false, error: `El campo tipo es obligatorio y debe ser uno de: ${TIPOS_VALIDOS.join(', ')}` });
  }
  if (!punto_acceso || !PUNTOS_VALIDOS.includes(punto_acceso)) {
    return res.status(400).json({ success: false, error: `El campo punto_acceso es obligatorio y debe ser uno de: ${PUNTOS_VALIDOS.join(', ')}` });
  }
  if (!descripcion || descripcion.trim().length < 10) {
    return res.status(400).json({ success: false, error: 'El campo descripcion es obligatorio y debe tener al menos 10 caracteres' });
  }

  // Validaciones por tipo
  if (tipo !== 'incidente' && foto_url) {
    return res.status(400).json({ success: false, error: 'foto_url solo se permite en registros de tipo incidente' });
  }
  if (tipo === 'incidente' && foto_url && !foto_url.startsWith(FOTO_URL_PREFIJO)) {
    return res.status(400).json({ success: false, error: 'foto_url debe ser una URL válida de Cloudinary' });
  }

  if (tipo === 'entrega_turno') {
    if (!firma_saliente || !firma_entrante) {
      return res.status(400).json({ success: false, error: 'Las firmas (firma_saliente y firma_entrante) son obligatorias en entrega de turno' });
    }
    if (!guardia_entrante_id) {
      return res.status(400).json({ success: false, error: 'guardia_entrante_id es obligatorio en entrega de turno' });
    }
    if (!validarBase64Size(firma_saliente) || !validarBase64Size(firma_entrante)) {
      return res.status(400).json({ success: false, error: 'Las firmas no pueden superar 200KB cada una' });
    }
  } else {
    if (firma_saliente || firma_entrante || guardia_entrante_id) {
      return res.status(400).json({ success: false, error: 'Las firmas y guardia_entrante_id solo se permiten en tipo entrega_turno' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const insertResult = await client.query(
      `INSERT INTO bitacoras_registros
         (guardia_id, tipo, punto_acceso, descripcion, observaciones,
          foto_url, firma_saliente, firma_entrante, guardia_entrante_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, tipo, punto_acceso, descripcion, guardia_id, created_at`,
      [
        req.usuario.id, tipo, punto_acceso, descripcion.trim(),
        observaciones ? observaciones.trim() : null,
        foto_url || null,
        firma_saliente || null,
        firma_entrante || null,
        guardia_entrante_id || null
      ]
    );

    const nuevo = insertResult.rows[0];

    await registrarAuditoria(client, {
      bitacora_id:   nuevo.id,
      usuario_id:    req.usuario.id,
      usuario_nombre: req.usuario.nombre,
      accion:        'crear',
      motivo:        null
    });

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: nuevo });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

// ─── GET /api/bitacoras ───────────────────────────────────────────────────────
router.get('/', verifyToken, esAdmin, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const base = ['b.deleted_at IS NULL'];
    const { conds, vals } = buildFiltros(req.query, [], base);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM bitacoras_registros b WHERE ${conds.join(' AND ')}`,
      vals
    );
    const total = parseInt(countResult.rows[0].count);

    vals.push(limit);
    vals.push(offset);
    const dataResult = await pool.query(
      `SELECT
         b.id, b.tipo, b.punto_acceso, b.descripcion,
         b.observaciones, b.foto_url, b.created_at,
         u.nombre AS guardia_nombre
       FROM bitacoras_registros b
       JOIN inhouse_usuarios u ON u.id = b.guardia_id
       WHERE ${conds.join(' AND ')}
       ORDER BY b.created_at DESC
       LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
      vals
    );

    res.json({
      success: true,
      data: {
        registros: dataResult.rows,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ─── GET /api/bitacoras/:id ───────────────────────────────────────────────────
router.get('/:id', verifyToken, esAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) {
    return res.status(400).json({ success: false, error: 'ID inválido' });
  }

  try {
    const result = await pool.query(
      `SELECT
         b.*,
         u.nombre  AS guardia_nombre,
         ue.nombre AS guardia_entrante_nombre
       FROM bitacoras_registros b
       JOIN inhouse_usuarios u   ON u.id  = b.guardia_id
       LEFT JOIN inhouse_usuarios ue ON ue.id = b.guardia_entrante_id
       WHERE b.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Registro no encontrado' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ─── GET /api/bitacoras/:id/auditoria ────────────────────────────────────────
router.get('/:id/auditoria', verifyToken, esAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) {
    return res.status(400).json({ success: false, error: 'ID inválido' });
  }

  try {
    const result = await pool.query(
      `SELECT
         a.id, a.accion, a.campo_modificado,
         a.valor_anterior, a.valor_nuevo,
         a.motivo, a.usuario_nombre, a.created_at
       FROM bitacoras_auditoria a
       WHERE a.bitacora_id = $1
       ORDER BY a.created_at ASC`,
      [id]
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ─── PUT /api/bitacoras/:id ───────────────────────────────────────────────────
router.put('/:id', verifyToken, esAdminOGuardia, puedeEditar, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) {
    return res.status(400).json({ success: false, error: 'ID inválido' });
  }

  const { descripcion, observaciones, motivo } = req.body;

  if (!motivo || motivo.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'El campo motivo es obligatorio para editar un registro' });
  }

  // Campos editables y sus validaciones
  const camposEditables = { descripcion, observaciones };

  // Filtrar solo los que vienen en el body
  const cambios = {};
  if (descripcion !== undefined) {
    if (descripcion.trim().length < 10) {
      return res.status(400).json({ success: false, error: 'La descripcion debe tener al menos 10 caracteres' });
    }
    cambios.descripcion = descripcion.trim();
  }
  if (observaciones !== undefined) {
    cambios.observaciones = observaciones ? observaciones.trim() : null;
  }

  if (Object.keys(cambios).length === 0) {
    return res.status(400).json({ success: false, error: 'No se enviaron campos para actualizar' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Leer valores actuales para auditoría
    const actual = await client.query(
      'SELECT descripcion, observaciones FROM bitacoras_registros WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    if (actual.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Registro no encontrado' });
    }
    const anterior = actual.rows[0];

    // Actualizar
    const setClauses = Object.keys(cambios).map((campo, i) => `${campo} = $${i + 2}`);
    setClauses.push(`updated_at = NOW()`);
    const updateVals = [id, ...Object.values(cambios)];

    await client.query(
      `UPDATE bitacoras_registros SET ${setClauses.join(', ')} WHERE id = $1`,
      updateVals
    );

    // Registrar auditoría por campo
    for (const campo of Object.keys(cambios)) {
      await registrarAuditoria(client, {
        bitacora_id:    id,
        usuario_id:     req.usuario.id,
        usuario_nombre: req.usuario.nombre,
        accion:         'editar',
        campo_modificado: campo,
        valor_anterior: String(anterior[campo] ?? ''),
        valor_nuevo:    String(cambios[campo] ?? ''),
        motivo:         motivo.trim()
      });
    }

    await client.query('COMMIT');
    res.json({ success: true, data: { message: 'Registro actualizado correctamente' } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

// ─── DELETE /api/bitacoras/:id ────────────────────────────────────────────────
router.delete('/:id', verifyToken, esAdminOGuardia, puedeEditar, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) {
    return res.status(400).json({ success: false, error: 'ID inválido' });
  }

  const { motivo } = req.body;
  if (!motivo || motivo.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'El campo motivo es obligatorio para eliminar un registro' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existe = await client.query(
      'SELECT id FROM bitacoras_registros WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    if (existe.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Registro no encontrado' });
    }

    // Soft delete
    await client.query(
      'UPDATE bitacoras_registros SET deleted_at = NOW(), deleted_by = $1, updated_at = NOW() WHERE id = $2',
      [req.usuario.id, id]
    );

    await registrarAuditoria(client, {
      bitacora_id:    id,
      usuario_id:     req.usuario.id,
      usuario_nombre: req.usuario.nombre,
      accion:         'eliminar',
      motivo:         motivo.trim()
    });

    await client.query('COMMIT');
    res.json({ success: true, data: { message: 'Registro eliminado correctamente' } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

module.exports = router;