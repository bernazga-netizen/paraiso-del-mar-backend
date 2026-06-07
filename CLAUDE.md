# Paraíso del Mar — Backend

## Stack
- Node.js + Express + Socket.io
- PostgreSQL en Neon (variable de entorno: `DATABASE_URL`)
- Deploy en Render, autodeploy desde branch `develop`

## Estructura de archivos
- `server.js` — servidor principal, configuración Express + Socket.io
- `routes-auth.js` — autenticación JWT y gestión de usuarios
- `routes-inhouse.js` — registros de huéspedes (CRUD completo)
- `routes-historial.js` — estadísticas y auditoría de accesos
- `routes-bitacoras.js` — bitácoras de seguridad (guardias)
- `middlewares/` — autenticación JWT
- `reset-password.js` — utilidad para resetear contraseñas con bcryptjs

## Reglas críticas
- Módulos nuevos van en archivos `routes-xxx.js` separados — nunca meter rutas directo en `server.js`
- En `server.js` solo agregar dos líneas por módulo nuevo: `require` y `app.use`
- Rutas estáticas (`/export`, `/historial`) deben declararse ANTES de `/:id` para evitar conflictos
- `multer` solo en rutas de upload — no aplicar globalmente
- Middleware de auth: `verifyToken` (no `verificarToken`). Popula `req.user` (no `req.usuario`)
- Nunca exponer `err.message` al cliente — usar mensajes genéricos en catch
- Usar `bcryptjs` (no `bcrypt`)
- Queries siempre parametrizadas — nunca concatenar strings en SQL

## Auth
- Login field: `nombre` (nombre completo, puede tener caracteres especiales)
- Token key en cliente: `pdm_acceso_token` en `sessionStorage`
- Roles: admin, recepcion, guardia

## Base de datos — prefijos de tablas
- `accesos_*` — control de accesos físicos
- `inhouse_*` — gestión de huéspedes
- `bitacoras_*` — bitácoras de seguridad
- `tickets_*` — sistema de tickets (pendiente)

## Tipos de huésped
- `H` = Propietario, `R` = Renta, `G` = Invitado, `P` = Residente Permanente
- Tipo `P` tiene `fecha_salida: null` — tratar como indefinido/ongoing
- `property_manager_id` es nullable

## Verificación de deploy
GET /api/health → debe responder `{"status":"OK","database":"Connected"}`
