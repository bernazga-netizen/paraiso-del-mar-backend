const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: 'OK', database: 'Connected', timestamp: result.rows[0].now });
  } catch (error) {
    res.status(500).json({ status: 'ERROR', error: error.message });
  }
});

app.get('/api/test/crear-muestra', async (req, res) => {
  try {
    const accesos = ['Muelle Principal', 'Base 4', 'Base 1'];
    const tipos = ['Dueño', 'Rentista', 'Golfista', 'Restaurante', 'Proveedor', 'Empleado', 'Administrativo'];
    const hoy = new Date().toISOString().split('T')[0];
    for (let i = 0; i < 10; i++) {
      const acceso = accesos[Math.floor(Math.random() * accesos.length)];
      const tipo = tipos[Math.floor(Math.random() * tipos.length)];
      const cantidad = Math.floor(Math.random() * 5) + 1;
      const hora = `${String(Math.floor(Math.random() * 24)).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}:00`;
      await pool.query('INSERT INTO registros (fecha, hora, acceso, tipo_persona, cantidad, usuario_captura, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7)', [hoy, hora, acceso, tipo, cantidad, 'prueba', Date.now()]);
    }
    res.json({ success: true, mensaje: '10 registros de prueba creados' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}`);
});

module.exports = { app, pool, io };