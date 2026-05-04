<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dashboard - Paraíso del Mar</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, sans-serif; background: #667eea; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { background: #1a237e; color: white; padding: 30px; text-align: center; border-radius: 10px; margin-bottom: 20px; }
        .header h1 { font-size: 32px; }
        .tabs { display: flex; gap: 10px; margin-bottom: 20px; }
        .tab { background: white; color: #1a237e; padding: 15px 30px; border-radius: 8px; cursor: pointer; font-weight: bold; border: 2px solid #1a237e; }
        .tab.active { background: #1a237e; color: white; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .controles { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; display: flex; gap: 15px; align-items: center; flex-wrap: wrap; }
        .controles label { font-weight: bold; color: #1a237e; font-size: 14px; }
        .controles input, .controles select { padding: 10px; border: 2px solid #1a237e; border-radius: 5px; font-size: 14px; }
        .controles button { background: #1a237e; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; }
        .controles button:hover { background: #0d47a1; }
        .btn-excel { background: #4caf50; }
        .btn-excel:hover { background: #388e3c; }
        .btn-limpiar { background: #ff9800; }
        .btn-limpiar:hover { background: #f57c00; }
        .filtros-section { background: #f5f5f5; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 2px solid #1a237e; }
        .filtros-title { font-weight: bold; color: #1a237e; margin-bottom: 10px; font-size: 16px; }
        .filtros-row { display: flex; gap: 15px; flex-wrap: wrap; align-items: center; }
        .filtro-group { display: flex; flex-direction: column; gap: 5px; }
        .kpi-container { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .kpi { background: white; padding: 20px; border-radius: 8px; text-align: center; }
        .kpi-numero { font-size: 36px; font-weight: bold; color: #1a237e; }
        .kpi-label { font-size: 12px; color: #666; margin-top: 5px; }
        .tabla { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .tabla h2 { color: #1a237e; margin-bottom: 15px; border-bottom: 2px solid #1a237e; padding-bottom: 10px; }
        table { width: 100%; border-collapse: collapse; }
        th { background: #f5f5f5; padding: 12px; text-align: left; font-weight: bold; border-bottom: 2px solid #ddd; font-size: 13px; }
        td { padding: 12px; border-bottom: 1px solid #eee; font-size: 13px; }
        .error { background: #f44336; color: white; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center; }
        .spinner { display: inline-block; width: 20px; height: 20px; border: 3px solid #f3f3f3; border-top: 3px solid #1a237e; border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .grafica { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
        canvas { max-height: 300px; }
        .badge-filtro { background: #1a237e; color: white; padding: 5px 10px; border-radius: 15px; font-size: 12px; display: inline-block; margin: 5px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📊 PARAÍSO DEL MAR</h1>
            <p>Dashboard de Control</p>
        </div>

        <div class="tabs">
            <div class="tab active" onclick="cambiarTab('estadisticas')">📈 ESTADÍSTICAS</div>
            <div class="tab" onclick="cambiarTab('auditoria')">📋 AUDITORÍA</div>
        </div>

        <!-- TAB: ESTADÍSTICAS -->
        <div id="tab-estadisticas" class="tab-content active">
            <div class="controles">
                <label>📅 Fecha:</label>
                <input type="date" id="fechaInput" value="">
                <button onclick="cargar()">🔄 ACTUALIZAR</button>
                <button class="btn-excel" onclick="exportarExcel()">📥 EXPORTAR EXCEL</button>
            </div>

            <div class="filtros-section">
                <div class="filtros-title">🔍 FILTROS AVANZADOS</div>
                <div class="filtros-row">
                    <div class="filtro-group">
                        <label>Tipo de Persona:</label>
                        <select id="filtroTipo">
                            <option value="">Todos</option>
                            <option value="Dueño">Dueño</option>
                            <option value="Rentista">Rentista</option>
                            <option value="Golfista">Golfista</option>
                            <option value="Restaurante">Restaurante</option>
                            <option value="Proveedor">Proveedor</option>
                            <option value="Empleado">Empleado</option>
                            <option value="Administrativo">Administrativo</option>
                        </select>
                    </div>
                    <div class="filtro-group">
                        <label>Acceso:</label>
                        <select id="filtroAcceso">
                            <option value="">Todos</option>
                            <option value="Muelle Principal">Muelle Principal</option>
                            <option value="Base 4">Base 4</option>
                            <option value="Base 1">Base 1</option>
                        </select>
                    </div>
                    <div class="filtro-group">
                        <label>Hora Desde:</label>
                        <input type="time" id="filtroHoraDesde" value="">
                    </div>
                    <div class="filtro-group">
                        <label>Hora Hasta:</label>
                        <input type="time" id="filtroHoraHasta" value="">
                    </div>
                    <div class="filtro-group">
                        <label>&nbsp;</label>
                        <button onclick="aplicarFiltros()">✓ APLICAR</button>
                    </div>
                    <div class="filtro-group">
                        <label>&nbsp;</label>
                        <button class="btn-limpiar" onclick="limpiarFiltros()">✕ LIMPIAR</button>
                    </div>
                </div>
                <div id="filtrosActivos" style="margin-top: 10px;"></div>
            </div>

            <div id="contenido">
                <p style="text-align: center; color: white; font-size: 18px;">
                    <span class="spinner"></span> Cargando...
                </p>
            </div>
        </div>

        <!-- TAB: AUDITORÍA -->
        <div id="tab-auditoria" class="tab-content">
            <div class="controles">
                <label>📅 Desde:</label>
                <input type="date" id="auditoriaFechaInicio" value="">
                <label>📅 Hasta:</label>
                <input type="date" id="auditoriaFechaFin" value="">
                <button onclick="cargarAuditoria()">🔄 BUSCAR</button>
                <button class="btn-excel" onclick="exportarAuditoriaExcel()">📥 EXPORTAR</button>
            </div>

            <div class="filtros-section">
                <div class="filtros-title">🔍 FILTROS DE AUDITORÍA</div>
                <div class="filtros-row">
                    <div class="filtro-group">
                        <label>Usuario:</label>
                        <input type="text" id="auditoriaUsuario" placeholder="Nombre del usuario">
                    </div>
                    <div class="filtro-group">
                        <label>Tipo:</label>
                        <select id="auditoriaTipo">
                            <option value="">Todos</option>
                            <option value="Dueño">Dueño</option>
                            <option value="Rentista">Rentista</option>
                            <option value="Golfista">Golfista</option>
                            <option value="Restaurante">Restaurante</option>
                            <option value="Proveedor">Proveedor</option>
                            <option value="Empleado">Empleado</option>
                            <option value="Administrativo">Administrativo</option>
                        </select>
                    </div>
                    <div class="filtro-group">
                        <label>Acceso:</label>
                        <select id="auditoriaAcceso">
                            <option value="">Todos</option>
                            <option value="Muelle Principal">Muelle Principal</option>
                            <option value="Base 4">Base 4</option>
                            <option value="Base 1">Base 1</option>
                        </select>
                    </div>
                </div>
            </div>

            <div id="contenidoAuditoria">
                <p style="text-align: center; color: white; font-size: 18px;">
                    Selecciona un rango de fechas y presiona BUSCAR
                </p>
            </div>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js"></script>
    <script>
       const API = 'https://paraiso-del-mar-backend.onrender.com';
       let datosActuales = null;
       let datosFiltrados = null;
       let chartInstance = null;
       let datosAuditoria = [];
       
       // Establecer fechas actuales
       const hoy = new Date().toISOString().split('T')[0];
       document.getElementById('fechaInput').value = hoy;
       document.getElementById('auditoriaFechaFin').value = hoy;
       
       const hace7dias = new Date();
       hace7dias.setDate(hace7dias.getDate() - 7);
       document.getElementById('auditoriaFechaInicio').value = hace7dias.toISOString().split('T')[0];

       function cambiarTab(tab) {
           document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
           document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
           
           if (tab === 'estadisticas') {
               document.querySelectorAll('.tab')[0].classList.add('active');
               document.getElementById('tab-estadisticas').classList.add('active');
           } else {
               document.querySelectorAll('.tab')[1].classList.add('active');
               document.getElementById('tab-auditoria').classList.add('active');
           }
       }
        
       async function cargar() {
            try {
                const fecha = document.getElementById('fechaInput').value;
                const res = await fetch(`${API}/api/estadisticas/${fecha}`);
                const data = await res.json();
                datosActuales = data;
                datosFiltrados = data;
                aplicarFiltros();
            } catch (e) {
                document.getElementById('contenido').innerHTML = `<div class="error">❌ Error: No se puede conectar a ${API}</div>`;
            }
        }

        function aplicarFiltros() {
            if (!datosActuales) return;

            const filtroTipo = document.getElementById('filtroTipo').value;
            const filtroAcceso = document.getElementById('filtroAcceso').value;
            const filtroHoraDesde = document.getElementById('filtroHoraDesde').value;
            const filtroHoraHasta = document.getElementById('filtroHoraHasta').value;

            let badgesHTML = '';
            if (filtroTipo) badgesHTML += `<span class="badge-filtro">Tipo: ${filtroTipo}</span>`;
            if (filtroAcceso) badgesHTML += `<span class="badge-filtro">Acceso: ${filtroAcceso}</span>`;
            if (filtroHoraDesde) badgesHTML += `<span class="badge-filtro">Desde: ${filtroHoraDesde}</span>`;
            if (filtroHoraHasta) badgesHTML += `<span class="badge-filtro">Hasta: ${filtroHoraHasta}</span>`;
            document.getElementById('filtrosActivos').innerHTML = badgesHTML;

            datosFiltrados = JSON.parse(JSON.stringify(datosActuales));

            if (filtroTipo || filtroAcceso) {
                if (datosFiltrados.detalladoPorAccesoYTipo) {
                    datosFiltrados.detalladoPorAccesoYTipo = datosFiltrados.detalladoPorAccesoYTipo.filter(d => {
                        let match = true;
                        if (filtroTipo && d.tipo_persona !== filtroTipo) match = false;
                        if (filtroAcceso && d.acceso !== filtroAcceso) match = false;
                        return match;
                    });

                    const tiposMap = {};
                    datosFiltrados.detalladoPorAccesoYTipo.forEach(d => {
                        if (!tiposMap[d.tipo_persona]) {
                            tiposMap[d.tipo_persona] = 0;
                        }
                        tiposMap[d.tipo_persona] += parseInt(d.total);
                    });
                    datosFiltrados.porTipo = Object.keys(tiposMap).map(tipo => ({
                        tipo_persona: tipo,
                        total: tiposMap[tipo]
                    }));

                    const accesosMap = {};
                    datosFiltrados.detalladoPorAccesoYTipo.forEach(d => {
                        if (!accesosMap[d.acceso]) {
                            accesosMap[d.acceso] = 0;
                        }
                        accesosMap[d.acceso] += parseInt(d.total);
                    });
                    datosFiltrados.porAcceso = Object.keys(accesosMap).map(acceso => ({
                        acceso: acceso,
                        total: accesosMap[acceso]
                    }));
                }
            }

            if ((filtroHoraDesde || filtroHoraHasta) && datosFiltrados.porHora) {
                datosFiltrados.porHora = datosFiltrados.porHora.filter(h => {
                    const hora = h.hora.substring(0, 5);
                    let match = true;
                    if (filtroHoraDesde && hora < filtroHoraDesde) match = false;
                    if (filtroHoraHasta && hora > filtroHoraHasta) match = false;
                    return match;
                });
            }

            let totalFiltrado = 0;
            if (datosFiltrados.detalladoPorAccesoYTipo) {
                totalFiltrado = datosFiltrados.detalladoPorAccesoYTipo.reduce((sum, d) => sum + parseInt(d.total), 0);
            } else {
                totalFiltrado = datosFiltrados.total;
            }
            datosFiltrados.total = totalFiltrado;

            mostrarDatos();
        }

        function limpiarFiltros() {
            document.getElementById('filtroTipo').value = '';
            document.getElementById('filtroAcceso').value = '';
            document.getElementById('filtroHoraDesde').value = '';
            document.getElementById('filtroHoraHasta').value = '';
            document.getElementById('filtrosActivos').innerHTML = '';
            datosFiltrados = datosActuales;
            mostrarDatos();
        }

        function mostrarDatos() {
            const data = datosFiltrados;
            
            let html = '<div class="kpi-container">';
            html += `<div class="kpi"><div class="kpi-numero">${data.total}</div><div class="kpi-label">TOTAL</div></div>`;
            
            if (data.detalladoPorAccesoYTipo && data.detalladoPorAccesoYTipo.length > 0) {
                const accesos = ['Muelle Principal', 'Base 4', 'Base 1'];
                accesos.forEach(nombreAcceso => {
                    const totalAcceso = data.detalladoPorAccesoYTipo
                        .filter(d => d.acceso === nombreAcceso)
                        .reduce((sum, d) => sum + parseInt(d.total), 0);
                    if (totalAcceso > 0) {
                        html += `<div class="kpi"><div class="kpi-numero">${totalAcceso}</div><div class="kpi-label">${nombreAcceso}</div></div>`;
                    }
                });
            } else if (data.porAcceso) {
                data.porAcceso.forEach(a => {
                    html += `<div class="kpi"><div class="kpi-numero">${a.total}</div><div class="kpi-label">${a.acceso}</div></div>`;
                });
            }
            html += '</div>';
            
            if (data.porHora && data.porHora.length > 0) {
                html += '<div class="grafica"><h2>📈 Ingresos por Hora</h2><canvas id="chartHora"></canvas></div>';
            }
            
            if (data.porTipo && data.porTipo.length > 0) {
                html += '<div class="tabla"><h2>Por Tipo de Persona</h2><table><tr><th>Tipo</th><th style="text-align: right;">Cantidad</th></tr>';
                data.porTipo.forEach(t => {
                    html += `<tr><td>${t.tipo_persona}</td><td style="text-align: right;">${t.total}</td></tr>`;
                });
                html += '</table></div>';
            }
            
            if (data.porAcceso && data.porAcceso.length > 0) {
                html += '<div class="tabla"><h2>Por Acceso</h2><table><tr><th>Acceso</th><th style="text-align: right;">Cantidad</th></tr>';
                data.porAcceso.forEach(a => {
                    html += `<tr><td>${a.acceso}</td><td style="text-align: right;">${a.total}</td></tr>`;
                });
                html += '</table></div>';
            }
            
            if (data.detalladoPorAccesoYTipo && data.detalladoPorAccesoYTipo.length > 0) {
                html += '<div class="tabla"><h2>Detalle por Acceso y Tipo</h2><table><tr><th>Acceso</th><th>Tipo</th><th style="text-align: right;">Cantidad</th></tr>';
                data.detalladoPorAccesoYTipo.forEach(d => {
                    html += `<tr><td>${d.acceso}</td><td>${d.tipo_persona}</td><td style="text-align: right;">${d.total}</td></tr>`;
                });
                html += '</table></div>';
            }
            
            document.getElementById('contenido').innerHTML = html;
            
            if (data.porHora && data.porHora.length > 0) {
                setTimeout(() => crearGrafica(data.porHora), 100);
            }
        }

        function crearGrafica(porHora) {
            const ctx = document.getElementById('chartHora');
            if (!ctx) return;
            
            if (chartInstance) {
                chartInstance.destroy();
            }
            
            chartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: porHora.map(h => h.hora.substring(0, 5)),
                    datasets: [{
                        label: 'Ingresos',
                        data: porHora.map(h => h.total),
                        borderColor: '#1a237e',
                        backgroundColor: 'rgba(26, 35, 126, 0.1)',
                        tension: 0.4,
                        fill: true
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: {
                        legend: { display: false }
                    },
                    scales: {
                        y: { beginAtZero: true }
                    }
                }
            });
        }

        function exportarExcel() {
            if (!datosFiltrados) {
                alert('No hay datos para exportar');
                return;
            }

            const fecha = document.getElementById('fechaInput').value;
            const wb = XLSX.utils.book_new();

            const resumen = [
                ['PARAÍSO DEL MAR - Reporte de Ingresos'],
                ['Fecha:', fecha],
                ['Total General:', datosFiltrados.total],
                [''],
                ['Por Acceso'],
                ['Acceso', 'Cantidad']
            ];
            if (datosFiltrados.porAcceso) {
                datosFiltrados.porAcceso.forEach(a => {
                    resumen.push([a.acceso, a.total]);
                });
            }
            resumen.push(['']);
            resumen.push(['Por Tipo de Persona']);
            resumen.push(['Tipo', 'Cantidad']);
            if (datosFiltrados.porTipo) {
                datosFiltrados.porTipo.forEach(t => {
                    resumen.push([t.tipo_persona, t.total]);
                });
            }

            const ws1 = XLSX.utils.aoa_to_sheet(resumen);
            XLSX.utils.book_append_sheet(wb, ws1, 'Resumen');

            if (datosFiltrados.detalladoPorAccesoYTipo && datosFiltrados.detalladoPorAccesoYTipo.length > 0) {
                const detalle = [
                    ['Acceso', 'Tipo de Persona', 'Cantidad']
                ];
                datosFiltrados.detalladoPorAccesoYTipo.forEach(d => {
                    detalle.push([d.acceso, d.tipo_persona, d.total]);
                });
                const ws2 = XLSX.utils.aoa_to_sheet(detalle);
                XLSX.utils.book_append_sheet(wb, ws2, 'Detalle');
            }

            if (datosFiltrados.porHora && datosFiltrados.porHora.length > 0) {
                const porHora = [
                    ['Hora', 'Cantidad']
                ];
                datosFiltrados.porHora.forEach(h => {
                    porHora.push([h.hora, h.total]);
                });
                const ws3 = XLSX.utils.aoa_to_sheet(porHora);
                XLSX.utils.book_append_sheet(wb, ws3, 'Por Hora');
            }

            XLSX.writeFile(wb, `Paraiso_del_Mar_${fecha}.xlsx`);
        }

        async function cargarAuditoria() {
            try {
                const fechaInicio = document.getElementById('auditoriaFechaInicio').value;
                const fechaFin = document.getElementById('auditoriaFechaFin').value;
                const usuario = document.getElementById('auditoriaUsuario').value;
                const tipo = document.getElementById('auditoriaTipo').value;
                const acceso = document.getElementById('auditoriaAcceso').value;

                let url = `${API}/api/auditoria?fecha_inicio=${fechaInicio}&fecha_fin=${fechaFin}`;
                if (usuario) url += `&usuario_captura=${usuario}`;
                if (tipo) url += `&tipo_persona=${tipo}`;
                if (acceso) url += `&acceso=${acceso}`;

                const res = await fetch(url);
                datosAuditoria = await res.json();

                if (datosAuditoria.length === 0) {
                    document.getElementById('contenidoAuditoria').innerHTML = '<p style="text-align: center; color: white; font-size: 18px;">No se encontraron registros</p>';
                    return;
                }

                let html = '<div class="tabla"><h2>📋 Histórico de Registros (Últimos 500)</h2>';
                html += '<table><tr><th>Fecha</th><th>Hora</th><th>Acceso</th><th>Tipo</th><th>Cantidad</th><th>Usuario</th><th>Timestamp</th></tr>';
                
                datosAuditoria.forEach(registro => {
                    const fecha = new Date(registro.timestamp);
                    const fechaFormato = fecha.toLocaleDateString('es-MX');
                    const horaFormato = fecha.toLocaleTimeString('es-MX');
                    
                    html += `<tr>
                        <td>${registro.fecha}</td>
                        <td>${registro.hora}</td>
                        <td>${registro.acceso}</td>
                        <td>${registro.tipo_persona}</td>
                        <td style="text-align: right;">${registro.cantidad}</td>
                        <td>${registro.usuario_captura}</td>
                        <td>${fechaFormato} ${horaFormato}</td>
                    </tr>`;
                });
                
                html += '</table></div>';
                document.getElementById('contenidoAuditoria').innerHTML = html;

            } catch (e) {
                document.getElementById('contenidoAuditoria').innerHTML = `<div class="error">❌ Error: No se puede conectar a ${API}</div>`;
            }
        }

        function exportarAuditoriaExcel() {
            if (datosAuditoria.length === 0) {
                alert('No hay datos de auditoría para exportar');
                return;
            }

            const wb = XLSX.utils.book_new();
            const data = [
                ['PARAÍSO DEL MAR - Auditoría de Registros'],
                ['Desde:', document.getElementById('auditoriaFechaInicio').value],
                ['Hasta:', document.getElementById('auditoriaFechaFin').value],
                [''],
                ['Fecha', 'Hora', 'Acceso', 'Tipo', 'Cantidad', 'Usuario', 'Timestamp']
            ];

            datosAuditoria.forEach(r => {
                const fecha = new Date(r.timestamp);
                const fechaFormato = fecha.toLocaleDateString('es-MX');
                const horaFormato = fecha.toLocaleTimeString('es-MX');
                
                data.push([
                    r.fecha,
                    r.hora,
                    r.acceso,
                    r.tipo_persona,
                    r.cantidad,
                    r.usuario_captura,
                    `${fechaFormato} ${horaFormato}`
                ]);
            });

            const ws = XLSX.utils.aoa_to_sheet(data);
            XLSX.utils.book_append_sheet(wb, ws, 'Auditoría');
            
            const fechaInicio = document.getElementById('auditoriaFechaInicio').value;
            const fechaFin = document.getElementById('auditoriaFechaFin').value;
            XLSX.writeFile(wb, `Auditoria_${fechaInicio}_a_${fechaFin}.xlsx`);
        }
        
        cargar();
        setInterval(cargar, 30000);
    </script>
</body>
</html>