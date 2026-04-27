const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*' }
});

// Configurar conexión a PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Middleware
app.use(cors());
app.use(express.json());

// ============================================
// 🔵 RUTA: Health check (verificar que servidor está vivo)
// ============================================
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ 
      status: 'OK', 
      database: 'Connected',
      timestamp: result.rows[0].now
    });
  } catch (error) {
    res.status(500).json({ status: 'ERROR', error: error.message });
  }
});

// ============================================
// 🔵 RUTA: Guardar nuevo registro
// ============================================
app.post('/api/registros', async (req, res) => {
  try {
    const { fecha, hora, acceso, tipo_persona, cantidad, embarcacion, notas, usuario_captura } = req.body;

    // Validar regla: Proveedores solo hasta 16:00
    if (tipo_persona === 'Proveedor') {
      const [horas] = hora.split(':');
      if (parseInt(horas) > 16) {
        return res.status(400).json({ 
          error: '⚠️ Proveedores no pueden ingresar después de 16:00' 
        });
      }
    }

    // Insertar en BD
    const resultado = await pool.query(
      `INSERT INTO registros 
       (fecha, hora, acceso, tipo_persona, cantidad, embarcacion, notas, usuario_captura, timestamp) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
       RETURNING *`,
      [fecha, hora, acceso, tipo_persona, cantidad, embarcacion || null, notas || '', usuario_captura, Date.now()]
    );

    // Notificar dashboard en tiempo real
    io.emit('nuevoRegistro', resultado.rows[0]);

    res.json({ 
      success: true, 
      mensaje: `✓ ${cantidad} ${tipo_persona}(s) registrado(s)`,
      data: resultado.rows[0] 
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 🔵 RUTA: Obtener estadísticas del día
// ============================================
app.get('/api/estadisticas/:fecha', async (req, res) => {
  try {
    const { fecha } = req.params;

    // Total por acceso
    const porAcceso = await pool.query(
      `SELECT acceso, SUM(cantidad)::INT as total 
       FROM registros 
       WHERE fecha = $1 
       GROUP BY acceso 
       ORDER BY total DESC`,
      [fecha]
    );

    // Total por tipo de persona
    const porTipo = await pool.query(
      `SELECT tipo_persona, SUM(cantidad)::INT as total 
       FROM registros 
       WHERE fecha = $1 
       GROUP BY tipo_persona 
       ORDER BY total DESC`,
      [fecha]
    );

    // Por hora (para gráfico de línea)
    const porHora = await pool.query(
      `SELECT hora, SUM(cantidad)::INT as total 
       FROM registros 
       WHERE fecha = $1 
       GROUP BY hora 
       ORDER BY hora`,
      [fecha]
    );

    // Total general
    const totalGeneral = await pool.query(
      `SELECT SUM(cantidad)::INT as total FROM registros WHERE fecha = $1`,
      [fecha]
    );

    // Total por acceso y tipo (detallado)
    const detalladoPorAccesoYTipo = await pool.query(
      `SELECT acceso, tipo_persona, SUM(cantidad)::INT as total 
       FROM registros 
       WHERE fecha = $1 
       GROUP BY acceso, tipo_persona 
       ORDER BY acceso, tipo_persona`,
      [fecha]
    );

    res.json({
      fecha,
      total: totalGeneral.rows[0]?.total || 0,
      porAcceso: porAcceso.rows,
      porTipo: porTipo.rows,
      porHora: porHora.rows,
      detalladoPorAccesoYTipo: detalladoPorAccesoYTipo.rows
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 🔵 RUTA: Obtener registros históricos
// ============================================
app.get('/api/registros', async (req, res) => {
  try {
    const { fecha, acceso, tipo, dias } = req.query;

    let query = 'SELECT * FROM registros WHERE 1=1';
    let params = [];

    if (fecha) {
      query += ` AND fecha = $${params.length + 1}`;
      params.push(fecha);
    }

    if (acceso) {
      query += ` AND acceso = $${params.length + 1}`;
      params.push(acceso);
    }

    if (tipo) {
      query += ` AND tipo_persona = $${params.length + 1}`;
      params.push(tipo);
    }

    if (dias) {
      query += ` AND fecha >= CURRENT_DATE - INTERVAL '${dias} days'`;
    }

    query += ' ORDER BY created_at DESC LIMIT 1000';

    const resultado = await pool.query(query, params);
    res.json(resultado.rows);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 🔵 RUTA: Obtener lista de usuarios (tablets)
// ============================================
app.get('/api/usuarios', async (req, res) => {
  try {
    const resultado = await pool.query(
      'SELECT id, nombre, tablet_id, acceso FROM usuarios WHERE activo = true'
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 🔵 RUTA: Obtener reportes por rango de fechas
// ============================================
app.get('/api/reporte/:fecha_inicio/:fecha_fin', async (req, res) => {
  try {
    const { fecha_inicio, fecha_fin } = req.params;

    const resultado = await pool.query(
      `SELECT 
        fecha, 
        acceso, 
        tipo_persona, 
        SUM(cantidad)::INT as total
       FROM registros 
       WHERE fecha BETWEEN $1 AND $2
       GROUP BY fecha, acceso, tipo_persona
       ORDER BY fecha DESC, acceso`,
      [fecha_inicio, fecha_fin]
    );

    res.json(resultado.rows);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 🔵 WebSocket: Conexión en tiempo real
// ============================================
io.on('connection', (socket) => {
  console.log(`✓ Cliente conectado: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(`✗ Cliente desconectado: ${socket.id}`);
  });
});

// ============================================
// 🟢 INICIAR SERVIDOR
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 SERVIDOR PARAÍSO DEL MAR EN LÍNEA`);
  console.log(`${'='.repeat(50)}`);
  console.log(`\n📍 Servidor: http://localhost:${PORT}`);
  console.log(`📊 API Health: http://localhost:${PORT}/health`);
  console.log(`\n✓ Base de datos conectada`);
  console.log(`✓ WebSockets activos`);
  console.log(`✓ CORS habilitado\n`);
});

module.exports = { app, pool, io };
