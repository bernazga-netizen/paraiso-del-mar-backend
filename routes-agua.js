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

    const r = await pool.query(
      `SELECT m.id, m.unidad, m.tipo, m.unidad_lectura, m.digitos, m.lat, m.lng,
              l.id AS lectura_id, l.estado, l.lectura_actual, l.consumo_m3, l.alertas
       FROM agua_medidores m
       LEFT JOIN agua_lecturas l
         ON l.medidor_id = m.id AND l.periodo_id = $1 AND l.deleted_at IS NULL
       WHERE m.deleted_at IS NULL
       ORDER BY m.tipo = 'casa' DESC, NULLIF(regexp_replace(m.unidad, '\\D', '', 'g'), '')::int NULLS LAST, m.unidad`,
      [periodo.id]
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

// GET /api/agua/periodos/:id/export — Excel del periodo (admin)
router.get('/periodos/:id/export', ...admin, async (req, res) => {
  const id = num(req.params.id);
  try {
    const pr = await pool.query(`SELECT * FROM agua_periodos WHERE id = $1`, [id]);
    if (!pr.rows.length) return res.status(404).json({ success: false, error: 'Periodo no encontrado' });
    const periodo = pr.rows[0];
    const r = await pool.query(
      `SELECT m.unidad, m.propietario, m.tipo, m.cobra, m.incluidos_m3, l.*
       FROM agua_medidores m
       LEFT JOIN agua_lecturas l ON l.medidor_id = m.id AND l.periodo_id = $1 AND l.deleted_at IS NULL
       WHERE m.deleted_at IS NULL
       ORDER BY m.tipo = 'casa' DESC, NULLIF(regexp_replace(m.unidad, '\\D', '', 'g'), '')::int NULLS LAST, m.unidad`, [id]
    );
    const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const nombreMes = `${MESES[periodo.mes - 1]} ${periodo.anio}`;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(MESES[periodo.mes - 1]);
    ws.columns = [
      { header: 'Unidad', key: 'unidad', width: 12 },
      { header: 'Propietario', key: 'propietario', width: 38 },
      { header: 'Unidad lectura', key: 'unidad_lectura', width: 10 },
      { header: 'Lectura anterior', key: 'lectura_anterior', width: 14 },
      { header: 'Lectura actual', key: 'lectura_actual', width: 14 },
      { header: 'Cambio medidor', key: 'cambio', width: 10 },
      { header: 'Consumo m³', key: 'consumo_m3', width: 12 },
      { header: 'm³ incluidos', key: 'incluidos_m3', width: 11 },
      { header: 'Nivel 1 m³', key: 'n1m', width: 10 }, { header: 'Nivel 2 m³', key: 'n2m', width: 10 },
      { header: 'Nivel 3 m³', key: 'n3m', width: 10 }, { header: 'Nivel 4 m³', key: 'n4m', width: 10 },
      { header: 'Nivel 5 m³', key: 'n5m', width: 10 },
      { header: 'Nivel 1 USD', key: 'n1u', width: 11 }, { header: 'Nivel 2 USD', key: 'n2u', width: 11 },
      { header: 'Nivel 3 USD', key: 'n3u', width: 11 }, { header: 'Nivel 4 USD', key: 'n4u', width: 11 },
      { header: 'Nivel 5 USD', key: 'n5u', width: 11 },
      { header: 'Total USD', key: 'cobro_usd', width: 12 },
      { header: 'Estado', key: 'estado', width: 12 },
      { header: 'Alertas', key: 'alertas', width: 24 },
      { header: 'Nota', key: 'nota', width: 40 },
      { header: 'Foto', key: 'foto_url', width: 18 }
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10212E' } };

    let totCasas = 0, totOtros = 0, m3Casas = 0;
    for (const x of r.rows) {
      const d = x.detalle_niveles || {};
      const g = (n, k) => (d[`nivel_${n}`] ? d[`nivel_${n}`][k] : null);
      const unidadLect = x.unidad_lectura === 'm3' ? 'm³' : x.unidad_lectura;
      const row = ws.addRow({
        unidad: x.unidad, propietario: x.propietario, unidad_lectura: unidadLect,
        lectura_anterior: num(x.lectura_anterior), lectura_actual: num(x.lectura_actual),
        cambio: x.cambio_medidor ? 'Sí' : '', consumo_m3: num(x.consumo_m3), incluidos_m3: num(x.incluidos_m3),
        n1m: g(1, 'm3'), n2m: g(2, 'm3'), n3m: g(3, 'm3'), n4m: g(4, 'm3'), n5m: g(5, 'm3'),
        n1u: g(1, 'usd'), n2u: g(2, 'usd'), n3u: g(3, 'usd'), n4u: g(4, 'usd'), n5u: g(5, 'usd'),
        cobro_usd: num(x.cobro_usd), estado: x.estado || 'sin lectura',
        alertas: x.alertas ? x.alertas.join(', ') : '', nota: x.nota || '', foto_url: x.foto_url ? 'Ver foto' : ''
      });
      if (x.foto_url) row.getCell('foto_url').value = { text: 'Ver foto', hyperlink: x.foto_url };
      if (x.tipo === 'casa') { totCasas += num(x.cobro_usd) || 0; m3Casas += num(x.consumo_m3) || 0; }
      else totOtros += num(x.cobro_usd) || 0;
    }
    ['n1u', 'n2u', 'n3u', 'n4u', 'n5u', 'cobro_usd'].forEach((k) => { ws.getColumn(k).numFmt = '"$"#,##0.00'; });
    ['consumo_m3', 'n1m', 'n2m', 'n3m', 'n4m', 'n5m'].forEach((k) => { ws.getColumn(k).numFmt = '#,##0.000'; });
    ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];

    const rs = wb.addWorksheet('Resumen');
    rs.columns = [{ header: 'Concepto', key: 'c', width: 40 }, { header: 'Valor', key: 'v', width: 18 }];
    rs.getRow(1).font = { bold: true };
    rs.addRow({ c: 'Periodo', v: nombreMes });
    rs.addRow({ c: 'Estado', v: periodo.estado });
    rs.addRow({ c: 'Consumo medido en casas (m³)', v: Math.round(m3Casas * 1000) / 1000 });
    rs.addRow({ c: 'Entrada a cisterna de casas (m³)', v: num(periodo.entrada_cisterna_m3) });
    if (num(periodo.entrada_cisterna_m3)) {
      rs.addRow({ c: 'No contabilizado (%)', v: Math.round((1 - m3Casas / num(periodo.entrada_cisterna_m3)) * 1000) / 10 });
    }
    rs.addRow({ c: 'Cobro casas (USD)', v: Math.round(totCasas * 100) / 100 });
    rs.addRow({ c: 'Cobro albercas y otros (USD)', v: Math.round(totOtros * 100) / 100 });
    rs.addRow({ c: 'Total a cobrar (USD)', v: Math.round((totCasas + totOtros) * 100) / 100 });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="agua-${periodo.anio}-${String(periodo.mes).padStart(2, '0')}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { errorInterno(res, err, 'GET /periodos/:id/export'); }
});

module.exports = router;
module.exports._test = { calcularConsumo, calcularCobro, evaluarAlertas, distanciaMetros };
