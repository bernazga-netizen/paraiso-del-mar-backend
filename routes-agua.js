// routes-agua.js — Módulo Lecturas de Agua (Spec v1.0 · 28-oct-2026)
// Usuarios: inhouse_usuarios. Roles: lecturista, admin_agua; admin/super_admin = acceso total.
const express    = require('express');
const router     = express.Router();
const { Pool }   = require('pg');
const cloudinary = require('cloudinary').v2;
const multer     = require('multer');
const ExcelJS    = require('exceljs');
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

// ─── Multer (memoria; la PWA comprime antes de subir) ─────────────────────────
const FOTO_MAX_BYTES = 500 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: FOTO_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Formato no permitido. Usa JPG o WEBP.'));
  }
});

// ─── Constantes ───────────────────────────────────────────────────────────────
const SUPER          = ['admin', 'super_admin'];
const LECTURA_ROLES  = ['lecturista', 'admin_agua', ...SUPER];
const ADMIN_ROLES    = ['admin_agua', ...SUPER];
const UNIDADES       = ['m3', 'L', 'x10'];
const TIPOS_MEDIDOR  = ['casa', 'alberca', 'balance'];
const FOTO_PREFIJO   = 'https://res.cloudinary.com/';
const FACTOR         = { m3: 1, L: 0.001, x10: 10 };
const VENTANA_EDICION_SEG = 300;
const UMBRAL_SIN_HISTORIAL_M3 = 50;
const MULTIPLO_ALTO  = 2;
const DISTANCIA_MAX_M = 50;

// ─── Middlewares ──────────────────────────────────────────────────────────────
// Solo tokens de usuarios inhouse (los de seguridad traen sistema:'seguridad')
function soloInhouse(req, res, next) {
  if (!req.user || req.user.sistema) {
    return res.status(403).json({ success: false, error: 'Acceso no permitido para este usuario' });
  }
  next();
}

function requireRoles(roles) {
  return (req, res, next) => {
    if (req.user && roles.includes(req.user.rol)) return next();
    return res.status(403).json({ success: false, error: 'Acceso denegado' });
  };
}

const lector = [verifyToken, soloInhouse, requireRoles(LECTURA_ROLES)];
const admin  = [verifyToken, soloInhouse, requireRoles(ADMIN_ROLES)];
const superA = [verifyToken, soloInhouse, requireRoles(SUPER)];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const esNumero = (v) => typeof v === 'number' && Number.isFinite(v);
const redondear = (v, d = 3) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

function calcularConsumo({ anterior, actual, unidad, cambio, finalRetirado, unidadRetirado, inicialNuevo }) {
  if (actual === null) return null;
  if (cambio) {
    const parteVieja = finalRetirado === null ? 0 : (finalRetirado - anterior) * FACTOR[unidadRetirado || unidad];
    const parteNueva = (actual - (inicialNuevo || 0)) * FACTOR[unidad];
    return redondear(parteVieja + parteNueva);
  }
  return redondear((actual - anterior) * FACTOR[unidad]);
}

// Igual que el Excel v2 y la carga inicial: m³ nivel i = max(0, min(c, hasta) − max(desde, incluidos))
function calcularCobro(consumo, incluidos, cobra, tarifa) {
  const detalle = {};
  let total = 0;
  for (const n of tarifa.niveles) {
    const hasta = n.hasta === null ? Infinity : Number(n.hasta);
    const m3 = (!cobra || consumo === null)
      ? 0
      : Math.max(0, Math.min(consumo, hasta) - Math.max(Number(n.desde), incluidos));
    const usd = Math.round(m3 * Number(n.precio) * 100) / 100;
    detalle[`nivel_${n.nivel}`] = { m3: redondear(m3), usd };
    total += usd;
  }
  return { total: Math.round(total * 100) / 100, detalle };
}

function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function evaluarAlertas({ consumo, promedio, cambio, sinQr, medidor, lat, lng }) {
  const alertas = [];
  if (consumo === 0) alertas.push('consumo_cero');
  if (consumo !== null && consumo > 0) {
    const umbral = promedio && promedio > 0 ? promedio * MULTIPLO_ALTO : UMBRAL_SIN_HISTORIAL_M3;
    if (consumo > umbral) alertas.push('consumo_alto');
  }
  if (cambio) alertas.push('cambio_medidor');
  if (sinQr) alertas.push('sin_qr');
  if (medidor.lat !== null && medidor.lng !== null && esNumero(lat) && esNumero(lng)) {
    if (distanciaMetros(Number(medidor.lat), Number(medidor.lng), lat, lng) > DISTANCIA_MAX_M) {
      alertas.push('fuera_de_lugar');
    }
  }
  return alertas;
}

async function periodoAbierto(db) {
  const r = await db.query(`SELECT * FROM agua_periodos WHERE estado = 'abierto' LIMIT 1`);
  return r.rows[0] || null;
}

async function tarifaVigente(db) {
  const r = await db.query(
    `SELECT * FROM agua_tarifas WHERE deleted_at IS NULL AND vigente_desde <= CURRENT_DATE
     ORDER BY vigente_desde DESC, id DESC LIMIT 1`
  );
  return r.rows[0] || null;
}

// Última lectura válida de un medidor antes del periodo indicado
async function lecturaAnterior(db, medidorId, periodo) {
  const r = await db.query(
    `SELECT l.lectura_actual FROM agua_lecturas l
     JOIN agua_periodos p ON p.id = l.periodo_id
     WHERE l.medidor_id = $1 AND l.deleted_at IS NULL AND l.lectura_actual IS NOT NULL
       AND (p.anio * 12 + p.mes) < ($2 * 12 + $3)
     ORDER BY p.anio DESC, p.mes DESC LIMIT 1`,
    [medidorId, periodo.anio, periodo.mes]
  );
  return r.rows.length ? num(r.rows[0].lectura_actual) : null;
}

// Promedio de consumo de los últimos 3 periodos cerrados con consumo > 0
async function promedioConsumo(db, medidorId) {
  const r = await db.query(
    `SELECT AVG(consumo_m3) AS prom FROM (
       SELECT l.consumo_m3 FROM agua_lecturas l
       JOIN agua_periodos p ON p.id = l.periodo_id
       WHERE l.medidor_id = $1 AND l.deleted_at IS NULL AND p.estado = 'cerrado' AND l.consumo_m3 > 0
       ORDER BY p.anio DESC, p.mes DESC LIMIT 3) t`,
    [medidorId]
  );
  return r.rows[0].prom === null ? null : redondear(Number(r.rows[0].prom));
}

async function auditar(db, { entidad, entidad_id, usuario_id, accion, campo, anterior, nuevo, motivo }) {
  await db.query(
    `INSERT INTO agua_auditoria (entidad, entidad_id, usuario_id, accion, campo_modificado, valor_anterior, valor_nuevo, motivo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [entidad, entidad_id, usuario_id, accion, campo || null,
     anterior === undefined || anterior === null ? null : String(anterior),
     nuevo === undefined || nuevo === null ? null : String(nuevo),
     motivo]
  );
}

function errorInterno(res, err, donde) {
  console.error(`agua ${donde}:`, err);
  return res.status(500).json({ success: false, error: 'Error interno del servidor' });
}

// ═════════════════════════════════════════════════════════════════════════════
// RUTAS ESTÁTICAS (antes de cualquier /:id)
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/agua/ruta — medidores activos del periodo abierto con su estado
router.get('/ruta', ...lector, async (req, res) => {
  try {
    const periodo = await periodoAbierto(pool);
    if (!periodo) return res.status(404).json({ success: false, error: 'No hay periodo abierto' });

    // Incluye qr_token, lectura anterior y promedio para que la PWA valide sin señal
    const r = await pool.query(
      `SELECT m.id, m.unidad, m.tipo, m.unidad_lectura, m.digitos, m.lat, m.lng, m.qr_token,
              l.id AS lectura_id, l.estado, l.lectura_actual, l.consumo_m3, l.alertas, l.lecturista_id, l.created_at AS lectura_creada,
              ant.lectura_actual AS lectura_anterior, ROUND(pr.prom, 3) AS promedio_m3,
              CASE WHEN l.estado = 'relectura' THEN (
                SELECT a.motivo FROM agua_auditoria a
                WHERE a.entidad = 'lectura' AND a.entidad_id = l.id AND a.accion = 'relectura'
                ORDER BY a.created_at DESC LIMIT 1) END AS motivo_relectura
       FROM agua_medidores m
       LEFT JOIN agua_lecturas l
         ON l.medidor_id = m.id AND l.periodo_id = $1 AND l.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT l2.lectura_actual FROM agua_lecturas l2 JOIN agua_periodos p2 ON p2.id = l2.periodo_id
         WHERE l2.medidor_id = m.id AND l2.deleted_at IS NULL AND l2.lectura_actual IS NOT NULL
           AND (p2.anio * 12 + p2.mes) < ($2 * 12 + $3)
         ORDER BY p2.anio DESC, p2.mes DESC LIMIT 1) ant ON TRUE
       LEFT JOIN LATERAL (
         SELECT AVG(t.consumo_m3) AS prom FROM (
           SELECT l3.consumo_m3 FROM agua_lecturas l3 JOIN agua_periodos p3 ON p3.id = l3.periodo_id
           WHERE l3.medidor_id = m.id AND l3.deleted_at IS NULL AND p3.estado = 'cerrado' AND l3.consumo_m3 > 0
           ORDER BY p3.anio DESC, p3.mes DESC LIMIT 3) t) pr ON TRUE
       WHERE m.deleted_at IS NULL
       ORDER BY m.tipo = 'casa' DESC, NULLIF(regexp_replace(m.unidad, '\\D', '', 'g'), '')::int NULLS LAST, m.unidad`,
      [periodo.id, periodo.anio, periodo.mes]
    );
    const medidores = r.rows.map((x) => ({ ...x, estado: x.estado || 'pendiente' }));
    const resumen = medidores.reduce((acc, x) => { acc[x.estado] = (acc[x.estado] || 0) + 1; return acc; }, {});
    res.json({ success: true, data: { periodo, resumen, total: medidores.length, medidores } });
  } catch (err) { errorInterno(res, err, 'GET /ruta'); }
});

// Datos de un medidor para capturar (por QR o por unidad)
async function datosCaptura(medidor) {
  const periodo = await periodoAbierto(pool);
  if (!periodo) return { error: [404, 'No hay periodo abierto'] };
  const [anterior, promedio, existente] = await Promise.all([
    lecturaAnterior(pool, medidor.id, periodo),
    promedioConsumo(pool, medidor.id),
    pool.query(
      `SELECT id, lectura_actual, estado, created_at, lecturista_id FROM agua_lecturas
       WHERE medidor_id = $1 AND periodo_id = $2 AND deleted_at IS NULL`,
      [medidor.id, periodo.id]
    )
  ]);
  return {
    data: {
      periodo: { id: periodo.id, anio: periodo.anio, mes: periodo.mes },
      medidor: {
        id: medidor.id, unidad: medidor.unidad, tipo: medidor.tipo,
        unidad_lectura: medidor.unidad_lectura, digitos: medidor.digitos,
        lat: medidor.lat, lng: medidor.lng
      },
      lectura_anterior: anterior,
      promedio_m3: promedio,
      lectura_existente: existente.rows[0] || null
    }
  };
}

// GET /api/agua/medidores/qr/:token
router.get('/medidores/qr/:token', ...lector, async (req, res) => {
  try {
    const m = await pool.query(
      `SELECT * FROM agua_medidores WHERE qr_token = $1 AND deleted_at IS NULL`, [req.params.token]
    );
    if (!m.rows.length) return res.status(404).json({ success: false, error: 'Código QR no reconocido' });
    const out = await datosCaptura(m.rows[0]);
    if (out.error) return res.status(out.error[0]).json({ success: false, error: out.error[1] });
    res.json({ success: true, data: out.data });
  } catch (err) { errorInterno(res, err, 'GET /medidores/qr'); }
});

// GET /api/agua/medidores/unidad/:unidad — búsqueda manual (QR dañado)
router.get('/medidores/unidad/:unidad', ...lector, async (req, res) => {
  try {
    const m = await pool.query(
      `SELECT * FROM agua_medidores WHERE unidad = $1 AND deleted_at IS NULL`, [String(req.params.unidad).trim()]
    );
    if (!m.rows.length) return res.status(404).json({ success: false, error: 'Unidad no encontrada' });
    const out = await datosCaptura(m.rows[0]);
    if (out.error) return res.status(out.error[0]).json({ success: false, error: out.error[1] });
    res.json({ success: true, data: { ...out.data, sin_qr: true } });
  } catch (err) { errorInterno(res, err, 'GET /medidores/unidad'); }
});

// POST /api/agua/upload-foto
router.post('/upload-foto', ...lector, (req, res, next) => {
  upload.single('foto')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'La foto supera 500 KB; comprímela antes de subir' : 'Imagen no válida';
      return res.status(400).json({ success: false, error: msg });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No se recibió ninguna imagen' });
    const hoy = new Date();
    const carpeta = `agua/${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;
    const resultado = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: carpeta, resource_type: 'image' },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      stream.end(req.file.buffer);
    });
    res.json({ success: true, data: { foto_url: resultado.secure_url } });
  } catch (err) {
    console.error('agua upload-foto:', err);
    res.status(500).json({ success: false, error: 'Error al subir la imagen' });
  }
});

// GET /api/agua/medidores — catálogo (admin)
router.get('/medidores', ...admin, async (req, res) => {
  try {
    const incluirBajas = req.query.incluir_bajas === 'true';
    const r = await pool.query(
      `SELECT * FROM agua_medidores ${incluirBajas ? '' : 'WHERE deleted_at IS NULL'}
       ORDER BY tipo = 'casa' DESC, NULLIF(regexp_replace(unidad, '\\D', '', 'g'), '')::int NULLS LAST, unidad`
    );
    res.json({ success: true, data: r.rows });
  } catch (err) { errorInterno(res, err, 'GET /medidores'); }
});

// POST /api/agua/medidores — alta (admin)
router.post('/medidores', ...admin, async (req, res) => {
  const b = req.body || {};
  const unidad = typeof b.unidad === 'string' ? b.unidad.trim() : String(b.unidad ?? '').trim();
  if (!unidad) return res.status(400).json({ success: false, error: 'unidad es obligatoria' });
  if (!TIPOS_MEDIDOR.includes(b.tipo)) return res.status(400).json({ success: false, error: `tipo debe ser: ${TIPOS_MEDIDOR.join(', ')}` });
  if (!UNIDADES.includes(b.unidad_lectura)) return res.status(400).json({ success: false, error: `unidad_lectura debe ser: ${UNIDADES.join(', ')}` });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO agua_medidores (unidad, propietario, tipo, unidad_lectura, digitos, serie, cobra, incluidos_m3, lat, lng, instalado_en, notas, qr_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, substr(md5(random()::text || clock_timestamp()::text), 1, 16))
       RETURNING *`,
      [unidad, b.propietario || null, b.tipo, b.unidad_lectura, num(b.digitos), b.serie || null,
       b.cobra !== false, num(b.incluidos_m3) ?? 24, num(b.lat), num(b.lng), b.instalado_en || null, b.notas || null]
    );
    await auditar(client, { entidad: 'medidor', entidad_id: r.rows[0].id, usuario_id: req.user.id, accion: 'crear', motivo: 'Alta de medidor' });
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ success: false, error: 'Ya existe un medidor con esa unidad' });
    errorInterno(res, err, 'POST /medidores');
  } finally { client.release(); }
});

// GET /api/agua/lecturas — consulta (admin). Filtros: periodo_id, estado, unidad
router.get('/lecturas', ...admin, async (req, res) => {
  try {
    let periodoId = num(req.query.periodo_id);
    if (!periodoId) {
      const p = await periodoAbierto(pool);
      periodoId = p ? p.id : null;
    }
    if (!periodoId) return res.json({ success: true, data: [] });
    const vals = [periodoId];
    const conds = ['l.periodo_id = $1', 'l.deleted_at IS NULL'];
    if (req.query.estado) { vals.push(String(req.query.estado)); conds.push(`l.estado = $${vals.length}`); }
    if (req.query.unidad) { vals.push(String(req.query.unidad)); conds.push(`m.unidad = $${vals.length}`); }
    if (req.query.con_alerta === 'true') conds.push(`array_length(l.alertas, 1) > 0`);
    const r = await pool.query(
      `SELECT l.*, m.unidad, m.propietario, m.tipo, u.nombre AS lecturista_nombre
       FROM agua_lecturas l
       JOIN agua_medidores m ON m.id = l.medidor_id
       LEFT JOIN inhouse_usuarios u ON u.id = l.lecturista_id
       WHERE ${conds.join(' AND ')}
       ORDER BY m.tipo = 'casa' DESC, NULLIF(regexp_replace(m.unidad, '\\D', '', 'g'), '')::int NULLS LAST, m.unidad`,
      vals
    );
    res.json({ success: true, data: r.rows });
  } catch (err) { errorInterno(res, err, 'GET /lecturas'); }
});

// POST /api/agua/lecturas — captura (lecturista / admin). Idempotente por client_uuid.
router.post('/lecturas', ...lector, async (req, res) => {
  const b = req.body || {};
  const uuidOk = typeof b.client_uuid === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.client_uuid);
  if (!uuidOk) return res.status(400).json({ success: false, error: 'client_uuid inválido' });

  const medidorId = num(b.medidor_id);
  const actual = num(b.lectura_actual);
  const cambio = b.cambio_medidor === true;
  if (!medidorId) return res.status(400).json({ success: false, error: 'medidor_id es obligatorio' });
  if (!esNumero(actual) || actual < 0) return res.status(400).json({ success: false, error: 'lectura_actual inválida' });
  if (!b.foto_url || !String(b.foto_url).startsWith(FOTO_PREFIJO)) {
    return res.status(400).json({ success: false, error: 'La foto del medidor es obligatoria' });
  }

  const client = await pool.connect();
  try {
    // Idempotencia: si ya existe ese client_uuid devolver el registro
    const dup = await client.query(`SELECT * FROM agua_lecturas WHERE client_uuid = $1`, [b.client_uuid]);
    if (dup.rows.length) return res.json({ success: true, data: dup.rows[0], duplicado: true });

    const periodo = await periodoAbierto(client);
    if (!periodo) return res.status(409).json({ success: false, error: 'No hay periodo abierto' });

    const mr = await client.query(`SELECT * FROM agua_medidores WHERE id = $1 AND deleted_at IS NULL`, [medidorId]);
    if (!mr.rows.length) return res.status(404).json({ success: false, error: 'Medidor no encontrado' });
    const medidor = mr.rows[0];

    if (medidor.digitos && String(Math.trunc(actual)).length > medidor.digitos) {
      return res.status(400).json({ success: false, error: `La lectura tiene más dígitos de los que muestra el medidor (${medidor.digitos})` });
    }

    const anterior = await lecturaAnterior(client, medidor.id, periodo);
    if (anterior === null) return res.status(409).json({ success: false, error: 'El medidor no tiene lectura anterior; regístrala desde administración' });

    let finalRetirado = null, unidadRetirado = null, inicialNuevo = null;
    if (cambio) {
      finalRetirado  = num(b.lect_final_retirado);
      unidadRetirado = b.unidad_retirado || medidor.unidad_lectura;
      inicialNuevo   = num(b.lect_inicial_nuevo) ?? 0;
      if (!UNIDADES.includes(unidadRetirado)) return res.status(400).json({ success: false, error: 'unidad_retirado inválida' });
      if (finalRetirado !== null && finalRetirado < anterior) {
        return res.status(400).json({ success: false, error: 'La lectura final del medidor retirado es menor a la anterior' });
      }
      if (actual < inicialNuevo) return res.status(400).json({ success: false, error: 'La lectura actual es menor a la inicial del medidor nuevo' });
    } else if (actual < anterior) {
      return res.status(400).json({ success: false, error: 'La lectura es menor a la anterior. Corrígela o registra un cambio de medidor', codigo: 'lectura_menor' });
    }

    const consumo = calcularConsumo({
      anterior, actual, unidad: medidor.unidad_lectura, cambio, finalRetirado, unidadRetirado, inicialNuevo
    });
    const promedio = await promedioConsumo(client, medidor.id);
    const alertas = evaluarAlertas({
      consumo, promedio, cambio, sinQr: b.sin_qr === true, medidor, lat: num(b.lat), lng: num(b.lng)
    });
    if (cambio && finalRetirado === null) alertas.push('falta_final_retirado');
    const nota = typeof b.nota === 'string' ? b.nota.trim().substring(0, 1000) : null;
    if (alertas.includes('consumo_alto') && !nota) {
      return res.status(400).json({ success: false, error: 'Consumo alto: la nota es obligatoria', codigo: 'nota_requerida', consumo_m3: consumo, promedio_m3: promedio });
    }

    await client.query('BEGIN');
    const existente = await client.query(
      `SELECT id FROM agua_lecturas WHERE medidor_id = $1 AND periodo_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [medidor.id, periodo.id]
    );
    if (existente.rows.length) {
      if (b.reemplazar !== true) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: 'Esta unidad ya tiene lectura en el periodo', codigo: 'duplicada', lectura_id: existente.rows[0].id });
      }
      await client.query(`UPDATE agua_lecturas SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`, [existente.rows[0].id]);
      await auditar(client, { entidad: 'lectura', entidad_id: existente.rows[0].id, usuario_id: req.user.id, accion: 'reemplazar', motivo: 'Reemplazada por nueva captura' });
    }

    const capturadaEn = b.capturada_en && !Number.isNaN(Date.parse(b.capturada_en)) ? b.capturada_en : new Date().toISOString();
    const ins = await client.query(
      `INSERT INTO agua_lecturas (client_uuid, medidor_id, periodo_id, lecturista_id, lectura_anterior, lectura_actual,
         unidad_lectura, cambio_medidor, lect_final_retirado, unidad_retirado, lect_inicial_nuevo, consumo_m3,
         foto_url, foto_retirado_url, lat, lng, sin_qr, estado, alertas, nota, capturada_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [b.client_uuid, medidor.id, periodo.id, req.user.id, anterior, actual,
       medidor.unidad_lectura, cambio, finalRetirado, cambio ? unidadRetirado : null, cambio ? inicialNuevo : null, consumo,
       b.foto_url, b.foto_retirado_url || null, num(b.lat), num(b.lng), b.sin_qr === true,
       alertas.length ? 'con_alerta' : 'validada', alertas.length ? alertas : null, nota, capturadaEn]
    );
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { ...ins.rows[0], promedio_m3: promedio } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      const d = await pool.query(`SELECT * FROM agua_lecturas WHERE client_uuid = $1`, [b.client_uuid]).catch(() => null);
      if (d && d.rows.length) return res.json({ success: true, data: d.rows[0], duplicado: true });
      return res.status(409).json({ success: false, error: 'Esta unidad ya tiene lectura en el periodo', codigo: 'duplicada' });
    }
    errorInterno(res, err, 'POST /lecturas');
  } finally { client.release(); }
});

// GET /api/agua/periodos (admin)
router.get('/periodos', ...admin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.*,
         (SELECT COUNT(*) FROM agua_lecturas l WHERE l.periodo_id = p.id AND l.deleted_at IS NULL)::int AS lecturas,
         (SELECT COALESCE(SUM(l.cobro_usd),0) FROM agua_lecturas l WHERE l.periodo_id = p.id AND l.deleted_at IS NULL) AS cobro_total_usd
       FROM agua_periodos p ORDER BY p.anio DESC, p.mes DESC`
    );
    res.json({ success: true, data: r.rows });
  } catch (err) { errorInterno(res, err, 'GET /periodos'); }
});

// GET /api/agua/tarifas (admin) · POST /api/agua/tarifas (super)
router.get('/tarifas', ...admin, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM agua_tarifas WHERE deleted_at IS NULL ORDER BY vigente_desde DESC, id DESC`);
    res.json({ success: true, data: r.rows });
  } catch (err) { errorInterno(res, err, 'GET /tarifas'); }
});

router.post('/tarifas', ...superA, async (req, res) => {
  const b = req.body || {};
  const niveles = Array.isArray(b.niveles) ? b.niveles : null;
  if (!b.vigente_desde || Number.isNaN(Date.parse(b.vigente_desde))) return res.status(400).json({ success: false, error: 'vigente_desde inválida' });
  if (!niveles || !niveles.length) return res.status(400).json({ success: false, error: 'niveles es obligatorio' });
  for (let i = 0; i < niveles.length; i++) {
    const n = niveles[i];
    const ultimo = i === niveles.length - 1;
    if (!esNumero(n.desde) || !esNumero(n.precio) || n.precio < 0) return res.status(400).json({ success: false, error: `Nivel ${i + 1} inválido` });
    if (!ultimo && (!esNumero(n.hasta) || n.hasta <= n.desde)) return res.status(400).json({ success: false, error: `Nivel ${i + 1}: hasta debe ser mayor que desde` });
    if (i > 0 && n.desde !== niveles[i - 1].hasta) return res.status(400).json({ success: false, error: `Nivel ${i + 1} debe iniciar donde termina el anterior` });
  }
  const normal = niveles.map((n, i) => ({ nivel: i + 1, desde: n.desde, hasta: i === niveles.length - 1 ? null : n.hasta, precio: n.precio }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO agua_tarifas (vigente_desde, incluidos_m3, niveles, moneda, creado_por)
       VALUES ($1,$2,$3::jsonb,$4,$5) RETURNING *`,
      [b.vigente_desde, num(b.incluidos_m3) ?? 24, JSON.stringify(normal), b.moneda || 'USD', req.user.id]
    );
    await auditar(client, { entidad: 'tarifa', entidad_id: r.rows[0].id, usuario_id: req.user.id, accion: 'crear', nuevo: JSON.stringify(normal), motivo: b.motivo || 'Nueva tarifa' });
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    errorInterno(res, err, 'POST /tarifas');
  } finally { client.release(); }
});

// GET /api/agua/auditoria (admin). Filtros: entidad, entidad_id
router.get('/auditoria', ...admin, async (req, res) => {
  try {
    const vals = [];
    const conds = ['1=1'];
    if (req.query.entidad) { vals.push(String(req.query.entidad)); conds.push(`a.entidad = $${vals.length}`); }
    if (req.query.entidad_id) { vals.push(num(req.query.entidad_id)); conds.push(`a.entidad_id = $${vals.length}`); }
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    vals.push(limit);
    const r = await pool.query(
      `SELECT a.*, u.nombre AS usuario_nombre FROM agua_auditoria a
       LEFT JOIN inhouse_usuarios u ON u.id = a.usuario_id
       WHERE ${conds.join(' AND ')} ORDER BY a.created_at DESC LIMIT $${vals.length}`,
      vals
    );
    res.json({ success: true, data: r.rows });
  } catch (err) { errorInterno(res, err, 'GET /auditoria'); }
});

// ═════════════════════════════════════════════════════════════════════════════
// RUTAS CON :id
// ═════════════════════════════════════════════════════════════════════════════

// PUT /api/agua/medidores/:id — edición o baja (admin)
router.put('/medidores/:id', ...admin, async (req, res) => {
  const id = num(req.params.id);
  const b = req.body || {};
  if (!b.motivo || !String(b.motivo).trim()) return res.status(400).json({ success: false, error: 'motivo es obligatorio' });
  const editables = ['propietario', 'tipo', 'unidad_lectura', 'digitos', 'serie', 'cobra', 'incluidos_m3', 'lat', 'lng', 'instalado_en', 'notas'];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT * FROM agua_medidores WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Medidor no encontrado' }); }
    const m = cur.rows[0];

    if (b.eliminar === true) {
      await client.query(`UPDATE agua_medidores SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`, [id]);
      await auditar(client, { entidad: 'medidor', entidad_id: id, usuario_id: req.user.id, accion: 'eliminar', motivo: String(b.motivo).trim() });
      await client.query('COMMIT');
      return res.json({ success: true, data: { id, eliminado: true } });
    }

    const sets = [], vals = [];
    for (const campo of editables) {
      if (!(campo in b)) continue;
      let v = b[campo];
      if (campo === 'tipo' && !TIPOS_MEDIDOR.includes(v)) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: 'tipo inválido' }); }
      if (campo === 'unidad_lectura' && !UNIDADES.includes(v)) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: 'unidad_lectura inválida' }); }
      if (['digitos', 'incluidos_m3', 'lat', 'lng'].includes(campo)) v = num(v);
      if (campo === 'cobra') v = v === true;
      vals.push(v); sets.push(`${campo} = $${vals.length}`);
      await auditar(client, { entidad: 'medidor', entidad_id: id, usuario_id: req.user.id, accion: 'editar', campo, anterior: m[campo], nuevo: v, motivo: String(b.motivo).trim() });
    }
    if (!sets.length) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: 'No hay cambios' }); }
    vals.push(id);
    const r = await client.query(
      `UPDATE agua_medidores SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length} RETURNING *`, vals
    );
    await client.query('COMMIT');
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    errorInterno(res, err, 'PUT /medidores/:id');
  } finally { client.release(); }
});

// POST /api/agua/medidores/:id/cambio — reemplazo físico de medidor (lecturista / admin)
// Actualiza unidad, serie y fecha en el catálogo; la lectura del mes se envía con cambio_medidor=true.
router.post('/medidores/:id/cambio', ...lector, async (req, res) => {
  const id = num(req.params.id);
  const b = req.body || {};
  if (!UNIDADES.includes(b.unidad_lectura)) return res.status(400).json({ success: false, error: 'unidad_lectura del medidor nuevo es obligatoria' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT * FROM agua_medidores WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Medidor no encontrado' }); }
    const m = cur.rows[0];
    const r = await client.query(
      `UPDATE agua_medidores SET unidad_lectura = $1, serie = $2, digitos = $3, instalado_en = COALESCE($4, CURRENT_DATE), updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [b.unidad_lectura, b.serie || null, num(b.digitos), b.instalado_en || null, id]
    );
    await auditar(client, {
      entidad: 'medidor', entidad_id: id, usuario_id: req.user.id, accion: 'cambio_medidor', campo: 'unidad_lectura/serie',
      anterior: `${m.unidad_lectura} / ${m.serie || '-'}`, nuevo: `${b.unidad_lectura} / ${b.serie || '-'}`,
      motivo: b.motivo ? String(b.motivo).trim() : 'Reemplazo de medidor'
    });
    await client.query('COMMIT');
    res.json({ success: true, data: { medidor: r.rows[0], unidad_retirado: m.unidad_lectura } });
  } catch (err) {
    await client.query('ROLLBACK');
    errorInterno(res, err, 'POST /medidores/:id/cambio');
  } finally { client.release(); }
});

// PUT /api/agua/lecturas/:id/revision — aprobar o pedir relectura (admin)
router.put('/lecturas/:id/revision', ...admin, async (req, res) => {
  const id = num(req.params.id);
  const { accion } = req.body || {};
  const nota = req.body && req.body.nota ? String(req.body.nota).trim() : null;
  if (!['aprobar', 'relectura'].includes(accion)) return res.status(400).json({ success: false, error: 'accion debe ser aprobar o relectura' });
  if (accion === 'relectura' && !nota) return res.status(400).json({ success: false, error: 'Indica el motivo de la relectura' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT l.*, p.estado AS periodo_estado FROM agua_lecturas l JOIN agua_periodos p ON p.id = l.periodo_id
       WHERE l.id = $1 AND l.deleted_at IS NULL FOR UPDATE OF l`, [id]
    );
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Lectura no encontrada' }); }
    if (cur.rows[0].periodo_estado !== 'abierto') { await client.query('ROLLBACK'); return res.status(409).json({ success: false, error: 'El periodo está cerrado' }); }
    const nuevo = accion === 'aprobar' ? 'aprobada' : 'relectura';
    const r = await client.query(
      `UPDATE agua_lecturas SET estado = $1, revisado_por = $2, revisado_en = NOW(), updated_at = NOW() WHERE id = $3 RETURNING *`,
      [nuevo, req.user.id, id]
    );
    await auditar(client, { entidad: 'lectura', entidad_id: id, usuario_id: req.user.id, accion, campo: 'estado', anterior: cur.rows[0].estado, nuevo, motivo: nota || 'Aprobada en revisión' });
    await client.query('COMMIT');
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    errorInterno(res, err, 'PUT /lecturas/:id/revision');
  } finally { client.release(); }
});

// PUT /api/agua/lecturas/:id — corrección. Lecturista: su propia lectura ≤ 5 min. Admin: siempre, con motivo.
router.put('/lecturas/:id', ...lector, async (req, res) => {
  const id = num(req.params.id);
  const b = req.body || {};
  const esAdmin = ADMIN_ROLES.includes(req.user.rol);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT l.*, p.estado AS periodo_estado, p.anio, p.mes FROM agua_lecturas l JOIN agua_periodos p ON p.id = l.periodo_id
       WHERE l.id = $1 AND l.deleted_at IS NULL FOR UPDATE OF l`, [id]
    );
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Lectura no encontrada' }); }
    const l = cur.rows[0];
    if (l.periodo_estado !== 'abierto') { await client.query('ROLLBACK'); return res.status(409).json({ success: false, error: 'El periodo está cerrado' }); }

    const segundos = (Date.now() - new Date(l.created_at).getTime()) / 1000;
    if (!esAdmin && (l.lecturista_id !== req.user.id || segundos > VENTANA_EDICION_SEG)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, error: 'El tiempo para corregir (5 minutos) ha expirado' });
    }
    const motivo = b.motivo ? String(b.motivo).trim() : (segundos <= VENTANA_EDICION_SEG ? 'Corrección inmediata' : null);
    if (!motivo) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: 'motivo es obligatorio' }); }

    const actual = 'lectura_actual' in b ? num(b.lectura_actual) : num(l.lectura_actual);
    if (!esNumero(actual) || actual < 0) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: 'lectura_actual inválida' }); }
    const anterior = num(l.lectura_anterior);
    if (!l.cambio_medidor && actual < anterior) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'La lectura es menor a la anterior', codigo: 'lectura_menor' });
    }
    const finalRetirado = 'lect_final_retirado' in b ? num(b.lect_final_retirado) : num(l.lect_final_retirado);
    const consumo = calcularConsumo({
      anterior, actual, unidad: l.unidad_lectura, cambio: l.cambio_medidor,
      finalRetirado, unidadRetirado: l.unidad_retirado, inicialNuevo: num(l.lect_inicial_nuevo)
    });
    const mr = await client.query(`SELECT * FROM agua_medidores WHERE id = $1`, [l.medidor_id]);
    const promedio = await promedioConsumo(client, l.medidor_id);
    const alertas = evaluarAlertas({ consumo, promedio, cambio: l.cambio_medidor, sinQr: l.sin_qr, medidor: mr.rows[0], lat: num(l.lat), lng: num(l.lng) });
    if (l.cambio_medidor && finalRetirado === null) alertas.push('falta_final_retirado');
    const nota = 'nota' in b ? (b.nota ? String(b.nota).trim().substring(0, 1000) : null) : l.nota;
    const foto = 'foto_url' in b ? b.foto_url : l.foto_url;
    if (!foto || !String(foto).startsWith(FOTO_PREFIJO)) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: 'La foto del medidor es obligatoria' }); }
    if (alertas.includes('consumo_alto') && !nota) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Consumo alto: la nota es obligatoria', codigo: 'nota_requerida' });
    }

    const r = await client.query(
      `UPDATE agua_lecturas SET lectura_actual = $1, lect_final_retirado = $2, consumo_m3 = $3, alertas = $4, estado = $5,
         nota = $6, foto_url = $7, revisado_por = NULL, revisado_en = NULL, updated_at = NOW()
       WHERE id = $8 RETURNING *`,
      [actual, finalRetirado, consumo, alertas.length ? alertas : null, alertas.length ? 'con_alerta' : 'validada', nota, foto, id]
    );
    for (const [campo, antes, despues] of [['lectura_actual', l.lectura_actual, actual], ['lect_final_retirado', l.lect_final_retirado, finalRetirado], ['foto_url', l.foto_url, foto]]) {
      if (String(antes ?? '') !== String(despues ?? '')) {
        await auditar(client, { entidad: 'lectura', entidad_id: id, usuario_id: req.user.id, accion: 'editar', campo, anterior: antes, nuevo: despues, motivo });
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    errorInterno(res, err, 'PUT /lecturas/:id');
  } finally { client.release(); }
});

// DELETE /api/agua/lecturas/:id — baja lógica (admin, con motivo)
router.delete('/lecturas/:id', ...admin, async (req, res) => {
  const id = num(req.params.id);
  const motivo = req.body && req.body.motivo ? String(req.body.motivo).trim() : null;
  if (!motivo) return res.status(400).json({ success: false, error: 'motivo es obligatorio' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE agua_lecturas l SET deleted_at = NOW(), updated_at = NOW()
       FROM agua_periodos p
       WHERE l.id = $1 AND l.deleted_at IS NULL AND p.id = l.periodo_id AND p.estado = 'abierto'
       RETURNING l.id`, [id]
    );
    if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Lectura no encontrada o periodo cerrado' }); }
    await auditar(client, { entidad: 'lectura', entidad_id: id, usuario_id: req.user.id, accion: 'eliminar', motivo });
    await client.query('COMMIT');
    res.json({ success: true, data: { id } });
  } catch (err) {
    await client.query('ROLLBACK');
    errorInterno(res, err, 'DELETE /lecturas/:id');
  } finally { client.release(); }
});

// PUT /api/agua/periodos/:id — entrada a cisterna (admin)
router.put('/periodos/:id', ...admin, async (req, res) => {
  const id = num(req.params.id);
  const entrada = num(req.body && req.body.entrada_cisterna_m3);
  if (entrada !== null && (!esNumero(entrada) || entrada < 0)) return res.status(400).json({ success: false, error: 'entrada_cisterna_m3 inválida' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT * FROM agua_periodos WHERE id = $1 FOR UPDATE`, [id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Periodo no encontrado' }); }
    if (cur.rows[0].estado !== 'abierto') { await client.query('ROLLBACK'); return res.status(409).json({ success: false, error: 'El periodo está cerrado' }); }
    const r = await client.query(`UPDATE agua_periodos SET entrada_cisterna_m3 = $1, updated_at = NOW() WHERE id = $2 RETURNING *`, [entrada, id]);
    await auditar(client, { entidad: 'periodo', entidad_id: id, usuario_id: req.user.id, accion: 'editar', campo: 'entrada_cisterna_m3', anterior: cur.rows[0].entrada_cisterna_m3, nuevo: entrada, motivo: 'Captura de entrada a cisterna' });
    await client.query('COMMIT');
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    errorInterno(res, err, 'PUT /periodos/:id');
  } finally { client.release(); }
});

// POST /api/agua/periodos/:id/cerrar — calcula cobros, congela tarifa y abre el siguiente mes (admin)
router.post('/periodos/:id/cerrar', ...admin, async (req, res) => {
  const id = num(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pr = await client.query(`SELECT * FROM agua_periodos WHERE id = $1 FOR UPDATE`, [id]);
    if (!pr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Periodo no encontrado' }); }
    const periodo = pr.rows[0];
    if (periodo.estado !== 'abierto') { await client.query('ROLLBACK'); return res.status(409).json({ success: false, error: 'El periodo ya está cerrado' }); }

    const faltantes = await client.query(
      `SELECT m.unidad FROM agua_medidores m
       WHERE m.deleted_at IS NULL AND NOT EXISTS (
         SELECT 1 FROM agua_lecturas l WHERE l.medidor_id = m.id AND l.periodo_id = $1
           AND l.deleted_at IS NULL AND l.lectura_actual IS NOT NULL)
       ORDER BY m.unidad`, [id]
    );
    const pendientes = await client.query(
      `SELECT m.unidad, l.estado FROM agua_lecturas l JOIN agua_medidores m ON m.id = l.medidor_id
       WHERE l.periodo_id = $1 AND l.deleted_at IS NULL AND l.estado IN ('con_alerta','relectura')
       ORDER BY m.unidad`, [id]
    );
    if (faltantes.rows.length || pendientes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false, error: 'No se puede cerrar: hay lecturas faltantes o alertas sin resolver',
        faltantes: faltantes.rows.map((x) => x.unidad),
        por_revisar: pendientes.rows
      });
    }

    const tarifa = await tarifaVigente(client);
    if (!tarifa) { await client.query('ROLLBACK'); return res.status(409).json({ success: false, error: 'No hay tarifa vigente' }); }
    const snapshot = { incluidos_m3: Number(tarifa.incluidos_m3), moneda: tarifa.moneda, niveles: tarifa.niveles, tarifa_id: tarifa.id };

    const lecturas = await client.query(
      `SELECT l.id, l.consumo_m3, m.cobra, m.incluidos_m3 FROM agua_lecturas l
       JOIN agua_medidores m ON m.id = l.medidor_id
       WHERE l.periodo_id = $1 AND l.deleted_at IS NULL`, [id]
    );
    let total = 0;
    for (const x of lecturas.rows) {
      const { total: cobro, detalle } = calcularCobro(num(x.consumo_m3), Number(x.incluidos_m3), x.cobra, snapshot);
      total += cobro;
      await client.query(
        `UPDATE agua_lecturas SET cobro_usd = $1, detalle_niveles = $2::jsonb, estado = 'cerrada', updated_at = NOW() WHERE id = $3`,
        [cobro, JSON.stringify(detalle), x.id]
      );
    }
    await client.query(
      `UPDATE agua_periodos SET estado = 'cerrado', tarifa_snapshot = $1::jsonb, cerrado_por = $2, cerrado_en = NOW(), updated_at = NOW() WHERE id = $3`,
      [JSON.stringify(snapshot), req.user.id, id]
    );
    const sigAnio = periodo.mes === 12 ? periodo.anio + 1 : periodo.anio;
    const sigMes  = periodo.mes === 12 ? 1 : periodo.mes + 1;
    const sig = await client.query(
      `INSERT INTO agua_periodos (anio, mes, estado) VALUES ($1,$2,'abierto')
       ON CONFLICT (anio, mes) DO NOTHING RETURNING *`, [sigAnio, sigMes]
    );
    await auditar(client, { entidad: 'periodo', entidad_id: id, usuario_id: req.user.id, accion: 'cerrar', nuevo: `cobro_total_usd=${Math.round(total * 100) / 100}`, motivo: 'Cierre de periodo' });
    await client.query('COMMIT');
    res.json({ success: true, data: { periodo_id: id, lecturas: lecturas.rows.length, cobro_total_usd: Math.round(total * 100) / 100, siguiente_periodo: sig.rows[0] || null } });
  } catch (err) {
    await client.query('ROLLBACK');
    errorInterno(res, err, 'POST /periodos/:id/cerrar');
  } finally { client.release(); }
});

// POST /api/agua/periodos/:id/reabrir — solo super administrador, con motivo
router.post('/periodos/:id/reabrir', ...superA, async (req, res) => {
  const id = num(req.params.id);
  const motivo = req.body && req.body.motivo ? String(req.body.motivo).trim() : null;
  if (!motivo) return res.status(400).json({ success: false, error: 'motivo es obligatorio' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pr = await client.query(`SELECT * FROM agua_periodos WHERE id = $1 FOR UPDATE`, [id]);
    if (!pr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Periodo no encontrado' }); }
    if (pr.rows[0].estado !== 'cerrado') { await client.query('ROLLBACK'); return res.status(409).json({ success: false, error: 'El periodo no está cerrado' }); }

    // El periodo abierto actual solo puede retirarse si no tiene lecturas
    const abierto = await periodoAbierto(client);
    if (abierto) {
      const c = await client.query(`SELECT COUNT(*)::int AS n FROM agua_lecturas WHERE periodo_id = $1 AND deleted_at IS NULL`, [abierto.id]);
      if (c.rows[0].n > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: `El periodo ${abierto.mes}/${abierto.anio} ya tiene lecturas; no se puede reabrir otro` });
      }
      await client.query(`DELETE FROM agua_periodos WHERE id = $1`, [abierto.id]);
      await auditar(client, { entidad: 'periodo', entidad_id: abierto.id, usuario_id: req.user.id, accion: 'retirar_abierto', motivo });
    }
    await client.query(`UPDATE agua_lecturas SET estado = 'aprobada', updated_at = NOW() WHERE periodo_id = $1 AND deleted_at IS NULL`, [id]);
    const r = await client.query(
      `UPDATE agua_periodos SET estado = 'abierto', cerrado_por = NULL, cerrado_en = NULL, updated_at = NOW() WHERE id = $1 RETURNING *`, [id]
    );
    await auditar(client, { entidad: 'periodo', entidad_id: id, usuario_id: req.user.id, accion: 'reabrir', motivo });
    await client.query('COMMIT');
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    errorInterno(res, err, 'POST /periodos/:id/reabrir');
  } finally { client.release(); }
});

// ─── Estado de cuenta del periodo ───────────────────────────────────────────
// Una sola fuente para el tablero, los recibos y el Excel. Periodo cerrado: usa el cobro
// congelado al cerrar (tarifa_snapshot). Periodo abierto: calcula con la tarifa vigente y
// marca preliminar = true (los montos pueden cambiar hasta el cierre).
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const MESES_HISTORIAL = 6;

function nivelAlcanzado(consumo, incluidos, tarifa) {
  if (consumo === null) return null;
  if (consumo <= incluidos) return 'Incluido';
  for (const n of tarifa.niveles) {
    if (n.hasta === null || consumo <= Number(n.hasta)) return `Nivel ${n.nivel}`;
  }
  return `Nivel ${tarifa.niveles[tarifa.niveles.length - 1].nivel}`;
}

async function estadoCuenta(db, periodoId) {
  const pr = await db.query(`SELECT * FROM agua_periodos WHERE id = $1`, [periodoId]);
  if (!pr.rows.length) return null;
  const periodo = pr.rows[0];
  const cerrado = periodo.estado === 'cerrado' && periodo.tarifa_snapshot;

  let tarifa;
  if (cerrado) {
    tarifa = periodo.tarifa_snapshot;
  } else {
    const t = await tarifaVigente(db);
    if (!t) return { periodo, error: 'No hay tarifa vigente' };
    tarifa = { incluidos_m3: Number(t.incluidos_m3), moneda: t.moneda, niveles: t.niveles, tarifa_id: t.id };
  }
  const niveles = [...tarifa.niveles].sort((a, b) => a.nivel - b.nivel);
  tarifa = { ...tarifa, niveles };

  const clave = periodo.anio * 12 + periodo.mes;
  const r = await db.query(
    `SELECT m.id AS medidor_id, m.unidad, m.propietario, m.tipo, m.cobra, m.incluidos_m3, m.serie,
            m.unidad_lectura AS unidad_medidor,
            l.id AS lectura_id, l.lectura_anterior, l.lectura_actual, l.unidad_lectura, l.cambio_medidor,
            l.lect_final_retirado, l.unidad_retirado, l.lect_inicial_nuevo, l.consumo_m3, l.cobro_usd,
            l.detalle_niveles, l.estado, l.alertas, l.nota, l.foto_url, l.capturada_en,
            u.nombre AS lecturista, ant.lectura_actual AS ultima_lectura
     FROM agua_medidores m
     LEFT JOIN agua_lecturas l ON l.medidor_id = m.id AND l.periodo_id = $1 AND l.deleted_at IS NULL
     LEFT JOIN inhouse_usuarios u ON u.id = l.lecturista_id
     LEFT JOIN LATERAL (
       SELECT l2.lectura_actual FROM agua_lecturas l2 JOIN agua_periodos p2 ON p2.id = l2.periodo_id
       WHERE l2.medidor_id = m.id AND l2.deleted_at IS NULL AND l2.lectura_actual IS NOT NULL
         AND (p2.anio * 12 + p2.mes) < $2
       ORDER BY p2.anio DESC, p2.mes DESC LIMIT 1) ant ON TRUE
     WHERE m.deleted_at IS NULL
     ORDER BY m.tipo = 'casa' DESC, NULLIF(regexp_replace(m.unidad, '\\D', '', 'g'), '')::int NULLS LAST, m.unidad`,
    [periodo.id, clave]
  );

  const h = await db.query(
    `SELECT l.medidor_id, p.anio, p.mes, l.consumo_m3
     FROM agua_lecturas l JOIN agua_periodos p ON p.id = l.periodo_id
     WHERE l.deleted_at IS NULL AND (p.anio * 12 + p.mes) BETWEEN $1 AND $2
     ORDER BY p.anio, p.mes`,
    [clave - (MESES_HISTORIAL - 1), clave]
  );
  const historial = {};
  for (const x of h.rows) (historial[x.medidor_id] ||= []).push({ anio: x.anio, mes: x.mes, consumo_m3: num(x.consumo_m3) });

  const vacio = () => ({ consumo_m3: 0, excedente_m3: 0, cobro_usd: 0, niveles: niveles.map((n) => ({ nivel: n.nivel, m3: 0, usd: 0 })), medidores: 0, con_lectura: 0, con_excedente: 0 });
  const grupos = { casas: vacio(), otros: vacio() };
  const distribucion = {};
  ['Incluido', ...niveles.map((n) => `Nivel ${n.nivel}`)].forEach((k) => { distribucion[k] = { unidades: 0, cobro_usd: 0 }; });
  const conteo = { medidores: r.rows.length, con_lectura: 0, sin_lectura: 0, con_alerta: 0, relectura: 0, validada: 0, aprobada: 0, cerrada: 0 };

  const filas = r.rows.map((x) => {
    const consumo = num(x.consumo_m3);
    const incluidos = Number(x.incluidos_m3);
    const tieneLectura = x.lectura_id !== null && num(x.lectura_actual) !== null;
    let detalle;
    let cobro;
    if (cerrado && x.detalle_niveles) {
      detalle = x.detalle_niveles;
      cobro = num(x.cobro_usd) || 0;
    } else {
      const c = calcularCobro(consumo, incluidos, x.cobra, tarifa);
      detalle = c.detalle;
      cobro = c.total;
    }
    const nivelesFila = niveles.map((n) => {
      const d = detalle[`nivel_${n.nivel}`] || { m3: 0, usd: 0 };
      return { nivel: n.nivel, m3: num(d.m3) || 0, usd: num(d.usd) || 0 };
    });
    const excedente = consumo === null ? null : redondear(Math.max(0, consumo - incluidos));
    const nivel = nivelAlcanzado(consumo, incluidos, tarifa);

    if (tieneLectura) conteo.con_lectura += 1; else conteo.sin_lectura += 1;
    if (x.estado && conteo[x.estado] !== undefined) conteo[x.estado] += 1;

    const g = grupos[x.tipo === 'casa' ? 'casas' : 'otros'];
    g.medidores += 1;
    if (tieneLectura) g.con_lectura += 1;
    if (x.cobra && consumo !== null) {
      g.consumo_m3 += consumo;
      g.excedente_m3 += excedente;
      g.cobro_usd += cobro;
      nivelesFila.forEach((nf, i) => { g.niveles[i].m3 += nf.m3; g.niveles[i].usd += nf.usd; });
      if (excedente > 0) g.con_excedente += 1;
      if (x.tipo === 'casa' && nivel && distribucion[nivel]) { distribucion[nivel].unidades += 1; distribucion[nivel].cobro_usd += cobro; }
    }

    return {
      medidor_id: x.medidor_id, unidad: x.unidad, propietario: x.propietario, tipo: x.tipo, cobra: x.cobra, serie: x.serie,
      incluidos_m3: incluidos, unidad_lectura: x.unidad_lectura || x.unidad_medidor,
      lectura_id: x.lectura_id,
      lectura_anterior: num(x.lectura_anterior) ?? num(x.ultima_lectura),
      lectura_actual: num(x.lectura_actual),
      cambio_medidor: !!x.cambio_medidor, lect_final_retirado: num(x.lect_final_retirado),
      unidad_retirado: x.unidad_retirado, lect_inicial_nuevo: num(x.lect_inicial_nuevo),
      consumo_m3: consumo, excedente_m3: excedente, niveles: nivelesFila,
      cobro_usd: x.cobra ? cobro : 0, nivel,
      estado: x.estado || 'sin_lectura', alertas: x.alertas || [], nota: x.nota,
      foto_url: x.foto_url, capturada_en: x.capturada_en, lecturista: x.lecturista,
      historial: historial[x.medidor_id] || []
    };
  });

  const r2 = (v) => Math.round(v * 100) / 100;
  for (const g of Object.values(grupos)) {
    g.consumo_m3 = redondear(g.consumo_m3); g.excedente_m3 = redondear(g.excedente_m3); g.cobro_usd = r2(g.cobro_usd);
    g.niveles.forEach((n) => { n.m3 = redondear(n.m3); n.usd = r2(n.usd); });
  }
  Object.values(distribucion).forEach((d) => { d.cobro_usd = r2(d.cobro_usd); });
  const entrada = num(periodo.entrada_cisterna_m3);

  return {
    periodo: { ...periodo, nombre: `${MESES[periodo.mes - 1]} ${periodo.anio}` },
    preliminar: !cerrado,
    tarifa,
    filas,
    conteo,
    grupos,
    distribucion,
    total_usd: r2(grupos.casas.cobro_usd + grupos.otros.cobro_usd),
    balance: {
      entrada_cisterna_m3: entrada,
      consumo_casas_m3: grupos.casas.consumo_m3,
      no_contabilizado_pct: entrada ? Math.round((1 - grupos.casas.consumo_m3 / entrada) * 1000) / 10 : null
    }
  };
}

// GET /api/agua/periodos/:id/estado-cuenta — tablero, recibos (admin)
router.get('/periodos/:id/estado-cuenta', ...admin, async (req, res) => {
  try {
    const ec = await estadoCuenta(pool, num(req.params.id));
    if (!ec) return res.status(404).json({ success: false, error: 'Periodo no encontrado' });
    if (ec.error) return res.status(409).json({ success: false, error: ec.error });
    res.json({ success: true, data: ec });
  } catch (err) { errorInterno(res, err, 'GET /periodos/:id/estado-cuenta'); }
});

// GET /api/agua/periodos/:id/export — Excel del periodo con el formato de "AA - Lectura Medidores Casas 2026 v2" (admin)
router.get('/periodos/:id/export', ...admin, async (req, res) => {
  try {
    const ec = await estadoCuenta(pool, num(req.params.id));
    if (!ec) return res.status(404).json({ success: false, error: 'Periodo no encontrado' });
    if (ec.error) return res.status(409).json({ success: false, error: ec.error });
    const { periodo, tarifa, filas, grupos } = ec;
    const N = tarifa.niveles.length;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Agua PDM';
    const ws = wb.addWorksheet(MESES[periodo.mes - 1], { views: [{ state: 'frozen', xSplit: 2, ySplit: 4 }] });

    const AZUL = 'FF10212E', GRIS = 'FFEEF2F4', AMARILLO = 'FFFFF4CC';
    const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
    const borde = { top: { style: 'thin', color: { argb: 'FFD9E0E4' } }, bottom: { style: 'thin', color: { argb: 'FFD9E0E4' } } };
    const rango = (n) => `${Number(n.desde)}–${n.hasta === null ? '∞' : Number(n.hasta)} m³`;

    // Columnas: A..E lecturas, F..I cambio, J..L cálculo, niveles m³, niveles USD, resultado, extras
    const cols = [
      ['Unidad', 10], ['Propietario', 34], ['Unidad lectura', 9], ['Lectura anterior', 14], ['Lectura actual', 14],
      ['¿Cambio de medidor?', 10], ['Lect. final medidor retirado', 14], ['Unidad medidor retirado', 10], ['Lect. inicial medidor nuevo', 12],
      ['Consumo m³', 11], ['m³ incluidos', 10], ['Excedente m³', 11],
      ...tarifa.niveles.map((n) => [`Nivel ${n.nivel}\n${rango(n)}`, 11]),
      ...tarifa.niveles.map((n) => [`Nivel ${n.nivel}\n$${Number(n.precio)}/m³`, 11]),
      ['Total USD', 12], ['Nivel', 10], ['Alerta', 26], ['Notas', 34], ['Estado', 12], ['Foto', 10]
    ];
    ws.columns = cols.map(([, width]) => ({ width }));
    const cTotal = 12 + 2 * N + 1;

    const titulo = ws.getCell('A1');
    titulo.value = `Lectura de medidores — ${periodo.nombre}`;
    titulo.font = { bold: true, size: 14 };
    ws.getCell('F1').value = ec.preliminar
      ? 'PRELIMINAR: periodo abierto, calculado con la tarifa vigente. Los montos se fijan al cerrar el periodo.'
      : `Periodo cerrado el ${periodo.cerrado_en ? new Date(periodo.cerrado_en).toLocaleDateString('es-MX', { timeZone: 'America/Mazatlan' }) : ''} — montos definitivos.`;
    ws.getCell('F1').font = { bold: true, color: { argb: ec.preliminar ? 'FF7A3206' : 'FF1F5536' } };

    const grupoCab = [
      [1, 5, 'LECTURAS'], [6, 9, 'SOLO SI SE CAMBIÓ EL MEDIDOR'], [10, 12, 'CÁLCULO'],
      [13, 12 + N, 'm³ POR NIVEL'], [13 + N, 12 + 2 * N, 'IMPORTE USD POR NIVEL'], [cTotal, cTotal + 5, 'RESULTADO']
    ];
    for (const [a, b, t] of grupoCab) {
      ws.mergeCells(3, a, 3, b);
      const c = ws.getCell(3, a);
      c.value = t; c.font = { bold: true, size: 10, color: { argb: 'FF34444F' } }; c.fill = fill(GRIS); c.alignment = { horizontal: 'center' };
    }
    const cab = ws.getRow(4);
    cab.values = cols.map(([t]) => t);
    cab.height = 32;
    cab.eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }; c.fill = fill(AZUL); c.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' }; });

    const unidadTxt = (u) => (u === 'm3' ? 'm³' : u || '');
    const ALERTA_TXT = {
      consumo_alto: 'Consumo alto', consumo_cero: 'Consumo cero', cambio_medidor: 'Cambio de medidor',
      sin_qr: 'Sin QR', fuera_de_lugar: 'Fuera de lugar', falta_final_retirado: 'Falta lectura del retirado'
    };
    const ESTADO_TXT = { sin_lectura: 'Sin lectura', validada: 'Validada', con_alerta: 'Con alerta', aprobada: 'Aprobada', relectura: 'Relectura', cerrada: 'Cerrada' };

    const filaDatos = (f) => {
      const v = [
        f.unidad, f.propietario, unidadTxt(f.unidad_lectura), f.lectura_anterior, f.lectura_actual,
        f.cambio_medidor ? 'Sí' : '', f.lect_final_retirado, f.cambio_medidor ? unidadTxt(f.unidad_retirado) : '', f.lect_inicial_nuevo,
        f.consumo_m3, f.incluidos_m3, f.excedente_m3,
        ...f.niveles.map((n) => (f.consumo_m3 === null ? null : n.m3)),
        ...f.niveles.map((n) => (f.consumo_m3 === null ? null : n.usd)),
        f.consumo_m3 === null ? null : f.cobro_usd,
        f.cobra ? (f.nivel || '') : 'No cobra',
        f.lectura_actual === null ? 'Sin lectura' : f.alertas.map((a) => ALERTA_TXT[a] || a).join(', '),
        f.nota || '', ESTADO_TXT[f.estado] || f.estado, ''
      ];
      const row = ws.addRow(v);
      if (f.foto_url) { const c = row.getCell(cTotal + 5); c.value = { text: 'Ver foto', hyperlink: f.foto_url }; c.font = { color: { argb: 'FF0A5F8A' }, underline: true }; }
      if (f.lectura_actual === null) row.getCell(5).fill = fill(AMARILLO);
      if (f.alertas.length) row.getCell(cTotal + 2).font = { color: { argb: 'FF7A3206' } };
      row.eachCell({ includeEmpty: true }, (c) => { c.border = borde; });
      return row;
    };
    const filaSubtotal = (texto, g) => {
      const row = ws.addRow([
        texto, '', '', '', '', '', '', '', '',
        g.consumo_m3, '', g.excedente_m3,
        ...g.niveles.map((n) => n.m3), ...g.niveles.map((n) => n.usd),
        g.cobro_usd, `${g.con_excedente} con excedente`, `${g.con_lectura}/${g.medidores} con lectura`, '', '', ''
      ]);
      row.font = { bold: true };
      row.eachCell({ includeEmpty: true }, (c) => { c.fill = fill(GRIS); });
      return row;
    };

    const casas = filas.filter((f) => f.tipo === 'casa');
    const otros = filas.filter((f) => f.tipo !== 'casa');
    casas.forEach(filaDatos);
    filaSubtotal(`Subtotal ${casas.length} casas`, grupos.casas);
    ws.addRow([]);
    otros.forEach(filaDatos);
    filaSubtotal('Subtotal albercas y otros', grupos.otros);
    ws.addRow([]);
    const tot = ws.addRow(['TOTAL A COBRAR']);
    tot.getCell(10).value = redondear(grupos.casas.consumo_m3 + grupos.otros.consumo_m3);
    tot.getCell(cTotal).value = ec.total_usd;
    tot.font = { bold: true, size: 12 };

    const fmtM3 = '#,##0.000;-#,##0.000;"-"', fmtUsd = '"$"#,##0.00;-"$"#,##0.00;"-"', fmtLect = '#,##0';
    [4, 5, 7, 9].forEach((c) => { ws.getColumn(c).numFmt = fmtLect; });
    for (let c = 10; c <= 12 + N; c++) ws.getColumn(c).numFmt = fmtM3;
    for (let c = 13 + N; c <= cTotal; c++) ws.getColumn(c).numFmt = fmtUsd;
    ws.getColumn(2).alignment = { wrapText: false };

    // Hoja Tarifa (la aplicada a este periodo)
    const tw = wb.addWorksheet('Tarifa');
    tw.columns = [{ width: 28 }, { width: 18 }, { width: 14 }, { width: 18 }];
    tw.addRow([ec.preliminar ? 'Tarifa vigente (preliminar)' : 'Tarifa aplicada al cierre']).font = { bold: true, size: 13 };
    tw.addRow([]);
    tw.addRow(['m³ incluidos por unidad / mes', Number(tarifa.incluidos_m3)]);
    tw.addRow(['Moneda', tarifa.moneda || 'USD']);
    tw.addRow([]);
    const tc = tw.addRow(['Nivel', 'Desde (más de) m³', 'Hasta m³', 'Precio USD / m³']);
    tc.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    tc.eachCell((c) => { c.fill = fill(AZUL); });
    tarifa.niveles.forEach((n) => tw.addRow([`Nivel ${n.nivel}`, Number(n.desde), n.hasta === null ? 'Sin límite' : Number(n.hasta), Number(n.precio)]));
    tw.getColumn(4).numFmt = '"$"#,##0.00';

    // Hoja Resumen
    const rs = wb.addWorksheet('Resumen');
    rs.columns = [{ width: 38 }, { width: 16 }, { width: 16 }];
    rs.addRow([`Resumen — ${periodo.nombre}`]).font = { bold: true, size: 13 };
    rs.addRow([ec.preliminar ? 'Preliminar (periodo abierto)' : 'Definitivo (periodo cerrado)']);
    rs.addRow([]);
    const add = (a, b, fmt) => { const row = rs.addRow([a, b]); if (fmt) row.getCell(2).numFmt = fmt; return row; };
    add('Medidores', ec.conteo.medidores);
    add('Con lectura', ec.conteo.con_lectura);
    add('Sin lectura', ec.conteo.sin_lectura);
    add('Con alerta sin revisar', ec.conteo.con_alerta);
    add('Relectura solicitada', ec.conteo.relectura);
    rs.addRow([]);
    add('Consumo casas (m³)', grupos.casas.consumo_m3, fmtM3);
    add('Excedente casas (m³)', grupos.casas.excedente_m3, fmtM3);
    add('Casas con excedente', grupos.casas.con_excedente);
    add('Cobro casas (USD)', grupos.casas.cobro_usd, fmtUsd);
    add('Cobro albercas y otros (USD)', grupos.otros.cobro_usd, fmtUsd);
    add('TOTAL A COBRAR (USD)', ec.total_usd, fmtUsd).font = { bold: true };
    rs.addRow([]);
    add('Entrada a cisterna de casas (m³)', ec.balance.entrada_cisterna_m3, fmtM3);
    add('No contabilizado (%)', ec.balance.no_contabilizado_pct);
    rs.addRow([]);
    const dc = rs.addRow(['Casas por nivel', 'Unidades', 'Cobro USD']);
    dc.font = { bold: true };
    for (const [k, d] of Object.entries(ec.distribucion)) { const row = rs.addRow([k, d.unidades, d.cobro_usd]); row.getCell(3).numFmt = fmtUsd; }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="agua-${periodo.anio}-${String(periodo.mes).padStart(2, '0')}${ec.preliminar ? '-preliminar' : ''}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { errorInterno(res, err, 'GET /periodos/:id/export'); }
});

module.exports = router;
module.exports._test = { calcularConsumo, calcularCobro, evaluarAlertas, distanciaMetros, nivelAlcanzado };
