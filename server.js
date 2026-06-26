// server.js
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const { verifyToken } = require('./middlewares/auth');
const authRouter     = require('./routes-auth');
const historialRouter = require('./routes-historial');
const inhouseRouter  = require('./routes-inhouse');
const bitacorasRouter = require('./routes-bitacoras'); // ← NUEVO
const seguridadAuthRoutes = require('./routes-seguridad-auth');
const seguridadRoutes = require('./routes-seguridad');

const app = express();
const server = http.createServer(app);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const allowedOrigins = [
  'https://paraiso-del-mar-app-web.vercel.app',
  'https://paraiso-del-mar-dashboard.vercel.app',
  'https://paraiso-del-mar-seguridad.vercel.app',
  'https://app.paraisodelmar.com',
  'http://localhost:3000',
  'http://localhost:5500',
  'https://paraiso-del-mar-dashboard-hmtjpxjkk-bernazga-netizens-projects.vercel.app',
  'https://paraiso-del-mar-dashboard-cdoi97sb4-bernazga-netizens-projects.vercel.app',
  'https://paraiso-del-mar-dashboard-k1tb4g2sb-bernazga-netizens-projects.vercel.app',
  'https://paraiso-del-mar-dashboard-l7kmk3y34-bernazga-netizens-projects.vercel.app',
  'https://paraiso-del-mar-dashboard-e6wwuc2d9-bernazga-netizens-projects.vercel.app',
  'https://paraiso-del-mar-dashboard-vz6hgnmy8-bernazga-netizens-projects.vercel.app',
  'https://paraiso-del-mar-dashboard-3dvfeu3ef-bernazga-netizens-projects.vercel.app',
  'https://paraiso-del-mar-dashboard-h9i1596co-bernazga-netizens-projects.vercel.app',
  'https://paraiso-del-mar-dashboard-lab0miub2-bernazga-netizens-projects.vercel.app'
];

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('CORS Socket.io bloqueado: ' + origin));
      }
    },
    methods: ['GET', 'POST']
  }
});

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS bloqueado: origen no permitido'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/api/auth',      authRouter);
app.use('/api/historial', historialRouter);
app.use('/api/inhouse',   inhouseRouter);
app.use('/api/bitacoras', bitacorasRouter);
app.use('/api/seguridad/auth', seguridadAuthRoutes);
app.use('/api/seguridad', seguridadRoutes);

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
    res.status(500).json({ status: 'ERROR', error: error.message });
  }
});

// ── Ruta de prueba — solo dashboard (requiere JWT) ──────────────────────────
app.get('/api/test/crear-muestra', verifyToken, async (req, res) => {
  try {
    const accesos = ['Muelle Principal', 'Base 4', 'Base 1'];
    const tipos = ['Dueño', 'Rentista', 'Golfista', 'Restaurante', 'Proveedor', 'Empleado', 'Administrativo'];
    const hoy = new Date().toISOString().split('T')[0];
    
    for (let i = 0; i < 10; i++) {
      const acceso = accesos[Math.floor(Math.random() * accesos.length)];
      const tipo = tipos[Math.floor(Math.random() * tipos.length)];
      const cantidad = Math.floor(Math.random() * 5) + 1;
      const hora = `${String(Math.floor(Math.random() * 24)).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}:00`;
      
      await pool.query(
        'INSERT INTO registros (fecha, hora, acceso, tipo_persona, cantidad, usuario_captura, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [hoy, hora, acceso, tipo, cantidad, 'prueba', Date.now()]
      );
    }
    
    res.json({ success: true, mensaje: '10 registros de prueba creados' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Rutas de tablets — SIN JWT (autenticación por PIN en frontend) ───────────
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

        io.emit('nuevoRegistro', { 
            fecha, 
            hora, 
            acceso, 
            tipo_persona, 
            cantidad 
        });

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

        const total = await pool.query(
            'SELECT COALESCE(SUM(cantidad), 0) as total FROM registros WHERE fecha = $1',
            [fecha]
        );

        const porAcceso = await pool.query(
            'SELECT acceso, SUM(cantidad) as total FROM registros WHERE fecha = $1 GROUP BY acceso ORDER BY acceso',
            [fecha]
        );

        const porTipo = await pool.query(
            'SELECT tipo_persona, SUM(cantidad) as total FROM registros WHERE fecha = $1 GROUP BY tipo_persona ORDER BY total DESC',
            [fecha]
        );

        const porHora = await pool.query(
            'SELECT hora, SUM(cantidad) as total FROM registros WHERE fecha = $1 GROUP BY hora ORDER BY hora',
            [fecha]
        );

        const detalladoPorAccesoYTipo = await pool.query(
            'SELECT acceso, tipo_persona, SUM(cantidad) as total FROM registros WHERE fecha = $1 GROUP BY acceso, tipo_persona ORDER BY acceso, tipo_persona',
            [fecha]
        );

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

// ── Rutas de dashboard — CON JWT ─────────────────────────────────────────────
app.get('/api/registros', verifyToken, async (req, res) => {
    try {
        const { fecha, acceso, tipo_persona } = req.query;
        let query = 'SELECT * FROM registros WHERE 1=1';
        const params = [];
        let paramCount = 1;

        if (fecha) {
            query += ` AND fecha = $${paramCount}`;
            params.push(fecha);
            paramCount++;
        }

        if (acceso) {
            query += ` AND acceso = $${paramCount}`;
            params.push(acceso);
            paramCount++;
        }

        if (tipo_persona) {
            query += ` AND tipo_persona = $${paramCount}`;
            params.push(tipo_persona);
            paramCount++;
        }

        query += ' ORDER BY fecha DESC, hora DESC LIMIT 100';

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        console.error('Error al obtener registros:', error);
        res.status(500).json({ error: 'Error al obtener registros' });
    }
});

app.get('/api/auditoria', verifyToken, async (req, res) => {
    try {
        const { fecha_inicio, fecha_fin, acceso, tipo_persona, usuario_captura } = req.query;
        let query = 'SELECT * FROM auditoria WHERE 1=1';
        const params = [];
        let paramCount = 1;

        if (fecha_inicio) {
            query += ` AND fecha >= $${paramCount}`;
            params.push(fecha_inicio);
            paramCount++;
        }

        if (fecha_fin) {
            query += ` AND fecha <= $${paramCount}`;
            params.push(fecha_fin);
            paramCount++;
        }

        if (acceso) {
            query += ` AND acceso = $${paramCount}`;
            params.push(acceso);
            paramCount++;
        }

        if (tipo_persona) {
            query += ` AND tipo_persona = $${paramCount}`;
            params.push(tipo_persona);
            paramCount++;
        }

        if (usuario_captura) {
            query += ` AND usuario_captura ILIKE $${paramCount}`;
            params.push(`%${usuario_captura}%`);
            paramCount++;
        }

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
    socket.on('disconnect', () => {
        console.log('Cliente desconectado');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}`);
});

module.exports = { app, pool, io };