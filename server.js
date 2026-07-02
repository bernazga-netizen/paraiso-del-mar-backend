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
  'http://localhost:5500'
];

// Previews de Vercel: cada deploy genera un subdominio distinto y Vercel trunca
// el nombre del proyecto cuando el team slug es largo (bernazga-netizens-projects),
// por lo que se valida el prefijo común + team slug en vez del nombre exacto del proyecto
// (ej. paraiso-del-mar-app-8rwzsnrst-bernazga-netizens-projects.vercel.app)
const allowedOriginPatterns = [
  /^https:\/\/paraiso-del-mar-[a-z0-9-]+-bernazga-netizens-projects\.vercel\.app$/
];

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  return allowedOriginPatterns.some(pattern => pattern.test(origin));
}

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
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
    if (isOriginAllowed(origin)) {
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
        const tipo_movimiento = req.body.tipo_movimiento === 'salida' ? 'salida' : 'entrada';

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
            'INSERT INTO registros (fecha, hora, acceso, tipo_persona, cantidad, embarcacion, notas, usuario_captura, timestamp, tipo_movimiento) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
            [fecha, hora, acceso, tipo_persona, cantidad, embarcacion, notas, usuario_captura, timestamp, tipo_movimiento]
        );

        await pool.query(
            'INSERT INTO auditoria (fecha, hora, acceso, tipo_persona, cantidad, usuario_captura, tipo_movimiento) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [fecha, hora, acceso, tipo_persona, cantidad, usuario_captura, tipo_movimiento]
        );

        io.emit('nuevoRegistro', {
            fecha,
            hora,
            acceso,
            tipo_persona,
            cantidad,
            tipo_movimiento
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

        const porMovimiento = await pool.query(
            'SELECT tipo_movimiento, COALESCE(SUM(cantidad), 0) as total FROM registros WHERE fecha = $1 GROUP BY tipo_movimiento',
            [fecha]
        );

        const entradas = porMovimiento.rows.find(r => r.tipo_movimiento === 'entrada');
        const salidas = porMovimiento.rows.find(r => r.tipo_movimiento === 'salida');

        const porAcceso = await pool.query(
            'SELECT acceso, SUM(cantidad) as total FROM registros WHERE fecha = $1 GROUP BY acceso ORDER BY acceso',
            [fecha]
        );

        const porTipo = await pool.query(
            'SELECT tipo_persona, SUM(cantidad) as total FROM registros WHERE fecha = $1 GROUP BY tipo_persona ORDER BY total DESC',
            [fecha]
        );

        const porHora = await pool.query(
            `SELECT hora,
                COALESCE(SUM(cantidad) FILTER (WHERE tipo_movimiento = 'entrada'), 0) as entradas,
                COALESCE(SUM(cantidad) FILTER (WHERE tipo_movimiento = 'salida'), 0) as salidas
             FROM registros WHERE fecha = $1 GROUP BY hora ORDER BY hora`,
            [fecha]
        );

        const detalladoPorAccesoYTipo = await pool.query(
            'SELECT acceso, tipo_persona, tipo_movimiento, SUM(cantidad) as total FROM registros WHERE fecha = $1 GROUP BY acceso, tipo_persona, tipo_movimiento ORDER BY acceso, tipo_persona',
            [fecha]
        );

        res.json({
            total: parseInt(total.rows[0].total),
            entradas: entradas ? parseInt(entradas.total) : 0,
            salidas: salidas ? parseInt(salidas.total) : 0,
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
        const { fecha_inicio, fecha_fin, acceso, tipo_persona, tipo_movimiento, usuario_captura } = req.query;
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

        if (tipo_movimiento) {
            query += ` AND tipo_movimiento = $${paramCount}`;
            params.push(tipo_movimiento);
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