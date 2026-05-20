const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// ── SEGURIDAD: CORS restringido al dominio del dashboard ────
const ALLOWED_ORIGINS = [
  'https://paraiso-del-mar-dashboard.vercel.app',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000'
];

const io = socketIo(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST']
  }
});

app.use(cors({
  origin: function (origin, callback) {
    // Permitir requests sin origin (Postman, curl, mobile apps)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('No permitido por CORS'));
  }
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Crear tabla de auditoría si no existe
pool.query(`
  CREATE TABLE IF NOT EXISTS auditoria (
    id SERIAL PRIMARY KEY,
    fecha DATE NOT NULL,
    hora TIME NOT NULL,
    acceso VARCHAR(50) NOT NULL,
    tipo_persona VARCHAR(50) NOT NULL,
    cantidad INTEGER NOT NULL,
    usuario_captura VARCHAR(100) NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).then(() => {
  console.log('✓ Tabla auditoria verificada');
}).catch(err => {
  console.error('Error al crear tabla auditoria:', err);
});

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: 'OK', database: 'Connected', timestamp: result.rows[0].now });
  } catch (error) {
    res.status(500).json({ status: 'ERROR', error: 'Error de base de datos' });
  }
});

// ── SEGURIDAD: endpoint de prueba ELIMINADO de producción ───
// GET /api/test/crear-muestra — removido por seguridad

app.post('/api/registros', async (req, res) => {
    try {
        const { fecha, hora, acceso, tipo_persona, cantidad, embarcacion, notas, usuario_captura } = req.body;

        if (tipo_persona === 'Proveedor') {
            const horaNum = parseInt(hora.split(':')[0]);
            if (horaNum >= 16) {
                return res.status(400).json({
                    error: 'Los proveedores no pueden ingresar después de las 4:00 PM'
                });
            }
        }

        const timestamp = Date.now();

        const resultRegistro = await pool.query(
            'INSERT INTO registros (fecha, hora, acceso, tipo_persona, cantidad, embarcacion, notas, usuario_captura, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
            [fecha, hora, acceso, tipo_persona, cantidad, embarcacion, notas, usuario_captura, timestamp]
        );

        await pool.query(
            'INSERT INTO auditoria (fecha, hora, acceso, tipo_persona, cantidad, usuario_captura) VALUES ($1, $2, $3, $4, $5, $6)',
            [fecha, hora, acceso, tipo_persona, cantidad, usuario_captura]
        );

        io.emit('nuevoRegistro', { fecha, hora, acceso, tipo_persona, cantidad });

        res.json({
            mensaje: 'Registro guardado exitosamente',
            id: resultRegistro.rows[0].id
        });
    } catch (error) {
        console.error('Error al guardar registro:', error);
        res.status(500).json({ error: 'Error al guardar el registro' });
    }
});

app.get('/api/estadisticas/:fecha', async (req, res) => {
    try {
        const { fecha } = req.params;
        const total = await pool.query('SELECT COALESCE(SUM(cantidad), 0) as total FROM registros WHERE fecha = $1', [fecha]);
        const porAcceso = await pool.query('SELECT acceso, SUM(cantidad) as total FROM registros WHERE fecha = $1 GROUP BY acceso ORDER BY acceso', [fecha]);
        const porTipo = await pool.query('SELECT tipo_persona, SUM(cantidad) as total FROM registros WHERE fecha = $1 GROUP BY tipo_persona ORDER BY total DESC', [fecha]);
        const porHora = await pool.query('SELECT hora, SUM(cantidad) as total FROM registros WHERE fecha = $1 GROUP BY hora ORDER BY hora', [fecha]);
        const detalladoPorAccesoYTipo = await pool.query('SELECT acceso, tipo_persona, SUM(cantidad) as total FROM registros WHERE fecha = $1 GROUP BY acceso, tipo_persona ORDER BY acceso, tipo_persona', [fecha]);
        res.json({
            total: parseInt(total.rows[0].total),
            porAcceso: porAcceso.rows,
            porTipo: porTipo.rows,
            porHora: porHora.rows,
            detalladoPorAccesoYTipo: detalladoPorAccesoYTipo.rows
        });
    } catch (error) {
        console.error('Error al obtener estadísticas:', error);
        res.status(500).json({ error: 'Error al obtener estadísticas' });
    }
});

app.get('/api/registros', async (req, res) => {
    try {
        const { fecha, acceso, tipo_persona } = req.query;
        let query = 'SELECT * FROM registros WHERE 1=1';
        const params = [];
        let paramCount = 1;
        if (fecha)        { query += ` AND fecha = $${paramCount}`; params.push(fecha); paramCount++; }
        if (acceso)       { query += ` AND acceso = $${paramCount}`; params.push(acceso); paramCount++; }
        if (tipo_persona) { query += ` AND tipo_persona = $${paramCount}`; params.push(tipo_persona); paramCount++; }
        query += ' ORDER BY fecha DESC, hora DESC LIMIT 100';
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        console.error('Error al obtener registros:', error);
        res.status(500).json({ error: 'Error al obtener registros' });
    }
});

app.get('/api/auditoria', async (req, res) => {
    try {
        const { fecha_inicio, fecha_fin, acceso, tipo_persona, usuario_captura } = req.query;
        let query = 'SELECT * FROM auditoria WHERE 1=1';
        const params = [];
        let paramCount = 1;
        if (fecha_inicio)    { query += ` AND fecha >= $${paramCount}`; params.push(fecha_inicio); paramCount++; }
        if (fecha_fin)       { query += ` AND fecha <= $${paramCount}`; params.push(fecha_fin); paramCount++; }
        if (acceso)          { query += ` AND acceso = $${paramCount}`; params.push(acceso); paramCount++; }
        if (tipo_persona)    { query += ` AND tipo_persona = $${paramCount}`; params.push(tipo_persona); paramCount++; }
        if (usuario_captura) { query += ` AND usuario_captura ILIKE $${paramCount}`; params.push(`%${usuario_captura}%`); paramCount++; }
        query += ' ORDER BY timestamp DESC LIMIT 500';
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        console.error('Error al obtener auditoría:', error);
        res.status(500).json({ error: 'Error al obtener auditoría' });
    }
});

io.on('connection', (socket) => {
    console.log('Cliente conectado');
    socket.on('disconnect', () => { console.log('Cliente desconectado'); });
});

// ── Módulo Inhouse ───────────────────────────────────────────
const inhouseRoutes   = require('./routes-inhouse');
const authRoutes      = require('./routes-auth');
const historialRoutes = require('./routes-historial');
app.use('/api/inhouse',   inhouseRoutes);
app.use('/api/auth',      authRoutes);
app.use('/api/historial', historialRoutes);
app.set('io', io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}`);
});

module.exports = { app, pool, io };
