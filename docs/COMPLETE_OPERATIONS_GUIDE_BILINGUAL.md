# 🎮 GUÍA OPERACIONAL COMPLETA DEL SISTEMA EV2 CLANDESTINOZ
# 🎮 EV2 CLANDESTINOZ COMPLETE OPERATIONAL GUIDE

**© 2024 EV2 CLANDESTINOZ - All Rights Reserved**

---

## 📑 TABLA DE CONTENIDOS / TABLE OF CONTENTS

1. [Inicio Rápido / Quick Start](#inicio-rápido)
2. [Comandos Esenciales / Essential Commands](#comandos-esenciales)
3. [Gestión de Usuarios / User Management](#gestión-de-usuarios)
4. [Gestión de Transacciones / Transaction Management](#gestión-de-transacciones)
5. [Operaciones Diarias / Daily Operations](#operaciones-diarias)
6. [Mantenimiento / Maintenance](#mantenimiento)
7. [Reportes / Reports](#reportes)
8. [Gestión de Errores / Error Management](#gestión-de-errores)

---

## 🚀 INICIO RÁPIDO / QUICK START

### **5 Minutos para Estar Operacional / 5 Minutes to Operation**

```bash
# 1. Clonar y entrar / Clone and enter
git clone https://github.com/ev2clandestinoz/platform.git
cd platform

# 2. Configurar variables / Setup variables
cp .env.example .env
nano .env  # Edita con tus valores / Edit with your values

# 3. Iniciar con Docker / Start with Docker
docker-compose up -d

# 4. Verificar que todo esté corriendo / Verify everything running
docker-compose ps

# 5. Acceder / Access
# Web: http://localhost:8080
# API: http://localhost:3000
```

### **Verificación Rápida / Quick Check**

```bash
# Ver estado de todos los servicios / Check all services status
docker-compose ps

# Ver logs en vivo / View live logs
docker-compose logs -f

# Verificar salud del sistema / Check system health
curl http://localhost:3000/api/health | jq .

# Contar usuarios activos / Count active users
curl http://localhost:3000/api/users/active | jq '.count'
```

---

## ⌨️ COMANDOS ESENCIALES / ESSENTIAL COMMANDS

### **Gestión de Servicios / Service Management**

```bash
# Iniciar todos los servicios / Start all services
docker-compose up -d

# Detener todos los servicios / Stop all services
docker-compose down

# Reiniciar un servicio / Restart a service
docker-compose restart nightclub-api

# Recrear un servicio / Recreate a service
docker-compose up -d --force-recreate nightclub-api

# Ver logs de un servicio / View service logs
docker-compose logs nightclub-api

# Logs en vivo de un servicio / Live logs
docker-compose logs -f nightclub-api

# Logs de múltiples servicios / Logs from multiple services
docker-compose logs -f nightclub-api reservations-api tip-system

# Entrar a un contenedor / Enter a container
docker-compose exec nightclub-api bash

# Ejecutar comando en contenedor / Run command in container
docker-compose exec nightclub-api npm run migrate:latest

# Ver estadísticas de recursos / View resource stats
docker stats

# Detener y limpiar todo / Stop and clean everything
docker-compose down -v
```

### **Gestión de Base de Datos / Database Management**

```bash
# Conectar a PostgreSQL / Connect to PostgreSQL
docker-compose exec postgres psql -U ev2_user -d ev2_clandestinoz

# Backup de base de datos / Backup database
docker-compose exec postgres pg_dump -U ev2_user ev2_clandestinoz > backup_$(date +%Y%m%d_%H%M%S).sql

# Restaurar backup / Restore backup
docker-compose exec -T postgres psql -U ev2_user ev2_clandestinoz < backup_20240115_120000.sql

# Ver estadísticas de BD / View database stats
docker-compose exec postgres psql -U ev2_user -d ev2_clandestinoz -c "SELECT * FROM pg_stat_user_tables;"

# Ejecutar migraciones / Run migrations
docker-compose exec nightclub-api npm run migrate:latest

# Revertir migraciones / Rollback migrations
docker-compose exec nightclub-api npm run migrate:rollback

# Llenar datos de prueba / Seed test data
docker-compose exec nightclub-api npm run seed:dev
```

### **Gestión de Cache / Cache Management**

```bash
# Conectar a Redis / Connect to Redis
docker-compose exec redis redis-cli

# Ver información de Redis / View Redis info
docker-compose exec redis redis-cli INFO

# Limpiar cache / Clear cache
docker-compose exec redis redis-cli FLUSHALL

# Ver keys en cache / View keys in cache
docker-compose exec redis redis-cli KEYS "*"

# Ver tamaño de cache / View cache size
docker-compose exec redis redis-cli DBSIZE

# Monitorear comandos en vivo / Monitor live commands
docker-compose exec redis redis-cli MONITOR
```

### **Gestión de Archivos / File Management**

```bash
# Ver estructura del proyecto / View project structure
tree -L 3 -I 'node_modules'

# Ver uso de disco / Check disk usage
du -sh server/*

# Limpiar archivos temporales / Clean temporary files
docker-compose exec nightclub-api rm -rf /tmp/*

# Ver tamaño de volúmenes / Check volume sizes
docker volume ls
docker volume inspect ev2_postgres_data
```

---

## 👥 GESTIÓN DE USUARIOS / USER MANAGEMENT

### **Crear Usuario / Create User**

```bash
# A través de API / Via API
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "John Doe",
    "email": "john@example.com",
    "password": "SecurePass123!",
    "role": "guest",
    "country": "MX"
  }'

# O en base de datos / Or in database
docker-compose exec postgres psql -U ev2_user -d ev2_clandestinoz -c "
  INSERT INTO users (name, email, password_hash, role, country) 
  VALUES ('John Doe', 'john@example.com', 'hash_value', 'guest', 'MX');
"
```

### **Listar Usuarios / List Users**

```bash
# Todos los usuarios / All users
curl http://localhost:3000/api/users \
  -H "Authorization: Bearer $TOKEN" | jq .

# Por rol / By role
curl "http://localhost:3000/api/users?role=staff" \
  -H "Authorization: Bearer $TOKEN" | jq .

# Por país / By country
curl "http://localhost:3000/api/users?country=MX" \
  -H "Authorization: Bearer $TOKEN" | jq .

# Activos hoy / Active today
curl "http://localhost:3000/api/users?active=today" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### **Modificar Usuario / Update User**

```bash
# Actualizar email / Update email
curl -X PUT http://localhost:3000/api/users/123 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"email": "newemail@example.com"}'

# Cambiar contraseña / Change password
curl -X PUT http://localhost:3000/api/users/123/password \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"password": "NewPass456!"}'

# Activar/Desactivar usuario / Activate/Deactivate user
curl -X PUT http://localhost:3000/api/users/123/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"active": false}'
```

### **Eliminar Usuario / Delete User**

```bash
# Eliminar usuario (soft delete) / Delete user (soft delete)
curl -X DELETE http://localhost:3000/api/users/123 \
  -H "Authorization: Bearer $TOKEN"

# Verificar usuario eliminado / Verify user deleted
curl http://localhost:3000/api/users/123 \
  -H "Authorization: Bearer $TOKEN"
# Retorna 404 / Returns 404
```

### **Gestión de Roles / Role Management**

```bash
# Roles disponibles / Available roles:
# - admin: Administrador del sistema / System admin
# - manager: Gerente del club / Club manager
# - staff: Personal del club / Club staff
# - valet: Empleado de valet / Valet employee
# - guest: Cliente / Customer

# Cambiar rol de usuario / Change user role
curl -X PUT http://localhost:3000/api/users/123/role \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"role": "staff"}'

# Dar permisos específicos / Grant specific permissions
curl -X POST http://localhost:3000/api/users/123/permissions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"permission": "manage_tables"}'
```

---

## 💳 GESTIÓN DE TRANSACCIONES / TRANSACTION MANAGEMENT

### **Propinas / Tips**

```bash
# Ver todas las propinas del día / View all tips today
curl "http://localhost:3004/api/tips?date=today" \
  -H "Authorization: Bearer $TOKEN" | jq .

# Propinas por personal / Tips by staff
curl "http://localhost:3004/api/tips/staff/456" \
  -H "Authorization: Bearer $TOKEN" | jq .

# Propinas por período / Tips by period
curl "http://localhost:3004/api/tips?from=2024-01-01&to=2024-01-31" \
  -H "Authorization: Bearer $TOKEN" | jq '.[] | {staff: .staff_name, total: .amount}'

# Monto total recaudado / Total collected
curl "http://localhost:3004/api/tips/stats" \
  -H "Authorization: Bearer $TOKEN" | jq '.total_amount'

# Top valets / Top tips today
curl "http://localhost:3004/api/tips/leaderboard?period=today" \
  -H "Authorization: Bearer $TOKEN" | jq '.[]'
```

### **Retiradas de Dinero / Withdrawals**

```bash
# Ver solicitudes de retirada pendientes / View pending withdrawals
curl "http://localhost:3005/api/withdrawals?status=pending" \
  -H "Authorization: Bearer $TOKEN" | jq .

# Aprobar retirada / Approve withdrawal
curl -X POST http://localhost:3005/api/withdrawals/789/approve \
  -H "Authorization: Bearer $TOKEN" \
  -d '{}'

# Rechazar retirada / Reject withdrawal
curl -X POST http://localhost:3005/api/withdrawals/789/reject \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"reason": "Información bancaria incorrecta"}'

# Marcar como procesada / Mark as processed
curl -X PUT http://localhost:3005/api/withdrawals/789/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"status": "completed", "transaction_id": "TXN123456"}'

# Ver historial de retiradas de empleado / View employee withdrawal history
curl "http://localhost:3005/api/employees/456/withdrawals" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### **Reservas / Reservations**

```bash
# Ver reservas del día / View today's reservations
curl "http://localhost:3001/api/reservations?date=today" \
  -H "Authorization: Bearer $TOKEN" | jq .

# Ver reservas próximas / View upcoming reservations
curl "http://localhost:3001/api/reservations?days=7" \
  -H "Authorization: Bearer $TOKEN" | jq .

# Crear reserva / Create reservation
curl -X POST http://localhost:3001/api/reservations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "user_id": "user-123",
    "table_id": 5,
    "date": "2024-02-15",
    "time": "22:00",
    "duration": 4,
    "guests": 6,
    "deposit": 500,
    "payment_method": "credit_card"
  }'

# Cancelar reserva / Cancel reservation
curl -X POST http://localhost:3001/api/reservations/456/cancel \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"reason": "Cambio de planes"}'

# Ver ingresos por reservas / View reservation revenue
curl "http://localhost:3001/api/reservations/stats" \
  -H "Authorization: Bearer $TOKEN" | jq '.total_revenue'
```

### **Transacciones de Pago / Payment Transactions**

```bash
# Ver todas las transacciones del día / View all transactions today
curl "http://localhost:3000/api/transactions?date=today" \
  -H "Authorization: Bearer $TOKEN" | jq .

# Transacciones por método / Transactions by method
curl "http://localhost:3000/api/transactions?method=credit_card" \
  -H "Authorization: Bearer $TOKEN" | jq .

# Monto total procesado / Total amount processed
curl "http://localhost:3000/api/transactions/stats" \
  -H "Authorization: Bearer $TOKEN" | jq '.total_amount'

# Ver transacciones fallidas / View failed transactions
curl "http://localhost:3000/api/transactions?status=failed" \
  -H "Authorization: Bearer $TOKEN" | jq .

# Reintentar transacción fallida / Retry failed transaction
curl -X POST http://localhost:3000/api/transactions/789/retry \
  -H "Authorization: Bearer $TOKEN" \
  -d '{}'

# Reembolsar transacción / Refund transaction
curl -X POST http://localhost:3000/api/transactions/789/refund \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"reason": "Solicitud del cliente"}'
```

---

## 📅 OPERACIONES DIARIAS / DAILY OPERATIONS

### **Apertura del Club / Club Opening**

```bash
# 8:00 AM - Verificar sistemas
# 8:00 AM - Check systems
docker-compose ps
docker exec ev2_postgres_1 psql -U ev2_user -d ev2_clandestinoz -c "SELECT version();"

# 8:30 AM - Verificar salud de API
# 8:30 AM - Check API health
curl http://localhost:3000/api/health | jq .

# 9:00 AM - Contar mesas disponibles
# 9:00 AM - Count available tables
curl http://localhost:3000/api/tables?status=available | jq '.length'

# 9:30 AM - Ver reservas del día
# 9:30 AM - View today's reservations
curl "http://localhost:3001/api/reservations?date=today" \
  -H "Authorization: Bearer $TOKEN" | jq '.length'

# 10:00 AM - Notificar al personal
# 10:00 AM - Notify staff
curl -X POST http://localhost:3000/api/notifications/broadcast \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"message": "Club abrirá en 2 horas"}'
```

### **Durante el Día / During the Day**

```bash
# Cada hora / Every hour:
# Monitorear transacciones / Monitor transactions
curl "http://localhost:3000/api/transactions?last_hour=true" \
  -H "Authorization: Bearer $TOKEN" | jq '.[] | {time: .timestamp, amount: .amount}'

# Verificar propinas recibidas / Check tips received
curl "http://localhost:3004/api/tips?last_hour=true" \
  -H "Authorization: Bearer $TOKEN" | jq '.[] | {staff: .staff_name, amount: .amount}'

# Ver usuarios activos / View active users
curl "http://localhost:3000/api/users/active?last_hour=true" \
  -H "Authorization: Bearer $TOKEN" | jq '.count'

# Cada 2 horas / Every 2 hours:
# Backup de datos / Backup data
docker-compose exec postgres pg_dump -U ev2_user ev2_clandestinoz > backup_$(date +%H%M%S).sql

# Limpiar cache antiguo / Clear old cache
docker-compose exec redis redis-cli FLUSHDB
```

### **Cierre del Club / Club Closing**

```bash
# 3:00 AM - Generar reporte del día
# 3:00 AM - Generate daily report
curl -X POST http://localhost:3000/api/reports/daily \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"date": "today"}'

# Ver ingresos totales del día / View total revenue
curl "http://localhost:3000/api/transactions/stats?date=today" \
  -H "Authorization: Bearer $TOKEN" | jq '.total_revenue'

# Ver propinas totales / View total tips
curl "http://localhost:3004/api/tips/stats?date=today" \
  -H "Authorization: Bearer $TOKEN" | jq '.total_amount'

# Procesar retiradas pendientes / Process pending withdrawals
curl "http://localhost:3005/api/withdrawals?status=pending" \
  -H "Authorization: Bearer $TOKEN" | jq '.[] | .id'

# Hacer backup final / Final backup
docker-compose exec postgres pg_dump -U ev2_user ev2_clandestinoz > final_backup_$(date +%Y%m%d).sql

# Limpiar datos temporales / Clear temporary data
docker-compose exec redis redis-cli FLUSHDB

# Desconectar usuarios / Disconnect users
curl -X POST http://localhost:3000/api/users/disconnect-all \
  -H "Authorization: Bearer $TOKEN" \
  -d '{}'

# Ver estado final / View final status
docker-compose ps
```

---

## 🔧 MANTENIMIENTO / MAINTENANCE

### **Mantenimiento Semanal / Weekly Maintenance**

```bash
# Lunes / Monday - Verificar Integridad de Datos / Verify Data Integrity
# Monday - Check database integrity
docker-compose exec postgres psql -U ev2_user -d ev2_clandestinoz -c "
  SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename))
  FROM pg_tables
  WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
  ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
"

# Miércoles / Wednesday - Actualizar Dependencias / Update Dependencies
# Wednesday - Check for updates
npm audit
npm outdated

# Viernes / Friday - Optimizar Base de Datos / Optimize Database
# Friday - Vacuum and analyze
docker-compose exec postgres psql -U ev2_user -d ev2_clandestinoz -c "VACUUM ANALYZE;"

# Domingo / Sunday - Backup Completo / Full Backup
# Sunday - Create full backup
docker-compose exec postgres pg_dump -U ev2_user ev2_clandestinoz > weekly_backup_$(date +%Y%m%d).sql
tar -czf weekly_backup_$(date +%Y%m%d).tar.gz weekly_backup_*.sql
```

### **Mantenimiento Mensual / Monthly Maintenance**

```bash
# Revisar logs de errores / Review error logs
docker-compose logs --since 30d | grep ERROR

# Analizar rendimiento / Analyze performance
docker stats --no-stream

# Revisar transacciones fallidas / Review failed transactions
curl "http://localhost:3000/api/transactions?status=failed&days=30" \
  -H "Authorization: Bearer $TOKEN" | jq '.[] | {id: .id, reason: .error}'

# Limpiar archivos antigos / Clean old files
find ./logs -type f -mtime +30 -delete
find ./backups -type f -mtime +30 -delete

# Actualizar certificados SSL / Update SSL certificates
sudo certbot renew

# Revisar documentación / Review documentation
# Asegúrate de que esté actualizada / Make sure it's updated
git pull origin main
```

### **Mantenimiento Anual / Annual Maintenance**

```bash
# Planificación de Capacidad / Capacity Planning
# Revisar métricas del año / Review year's metrics
curl "http://localhost:3000/api/reports/annual" \
  -H "Authorization: Bearer $TOKEN"

# Upgrade de infraestructura / Infrastructure upgrade
# Evaluar necesidades / Evaluate needs
docker stats --no-stream

# Renovación de certificados / Renew certificates
sudo certbot renew --force-renewal

# Auditoría de seguridad / Security audit
npm audit
npm audit fix --force

# Backup completo a almacenamiento externo / Full backup to external storage
# Asegúrate de tener 1 año de datos / Ensure you have 1 year of data
```

---

## 📊 REPORTES / REPORTS

### **Reporte Diario / Daily Report**

```bash
# Generar reporte del día / Generate daily report
curl -X POST http://localhost:3000/api/reports/daily \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "date": "2024-01-15",
    "include": ["revenue", "tips", "transactions", "users"]
  }' | jq .

# Salida esperada / Expected output:
{
  "date": "2024-01-15",
  "revenue": 12500,
  "tips": 3400,
  "transactions": 234,
  "active_users": 156,
  "new_users": 12,
  "top_table": 5,
  "top_staff": "María García",
  "top_staff_earnings": 850
}
```

### **Reporte Semanal / Weekly Report**

```bash
# Generar reporte semanal / Generate weekly report
curl -X POST http://localhost:3000/api/reports/weekly \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "week_start": "2024-01-08",
    "include": ["revenue", "growth", "top_performers"]
  }' | jq .
```

### **Reporte Mensual / Monthly Report**

```bash
# Generar reporte mensual / Generate monthly report
curl -X POST http://localhost:3000/api/reports/monthly \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "month": 1,
    "year": 2024
  }' | jq .

# Exportar como PDF / Export as PDF
curl -X GET "http://localhost:3000/api/reports/monthly/2024-01?format=pdf" \
  -H "Authorization: Bearer $TOKEN" \
  -o report_2024_01.pdf
```

### **Reporte Financiero / Financial Report**

```bash
# Ingresos por fuente / Revenue by source
curl "http://localhost:3000/api/reports/revenue/breakdown" \
  -H "Authorization: Bearer $TOKEN" | jq .

# Ganancias de empleados / Employee earnings
curl "http://localhost:3005/api/reports/employee-earnings?month=01" \
  -H "Authorization: Bearer $TOKEN" | jq '.[] | {name: .name, total: .total}'

# Comparativa mes a mes / Month-over-month comparison
curl "http://localhost:3000/api/reports/monthly-comparison" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

---

## ⚠️ GESTIÓN DE ERRORES / ERROR MANAGEMENT

### **Tipos de Errores Comunes / Common Error Types**

```
1. Error 400 - Bad Request / Solicitud inválida
   Causa: Parámetros incorrectos
   Solución: Verifica la solicitud

2. Error 401 - Unauthorized / No autorizado
   Causa: Token expirado o inválido
   Solución: Obtén nuevo token

3. Error 403 - Forbidden / Prohibido
   Causa: Permiso insuficiente
   Solución: Verifica rol del usuario

4. Error 404 - Not Found / No encontrado
   Causa: Recurso no existe
   Solución: Verifica ID del recurso

5. Error 500 - Internal Server Error / Error interno
   Causa: Error del servidor
   Solución: Revisa logs del servidor
```

### **Ver Errores / View Errors**

```bash
# Errores de la última hora / Errors from last hour
docker-compose logs --since 1h | grep ERROR

# Errores de un servicio / Errors from specific service
docker-compose logs nightclub-api | grep ERROR

# Conteo de errores / Error count
docker-compose logs | grep ERROR | wc -l

# Errores por tipo / Errors by type
docker-compose logs | grep ERROR | cut -d':' -f2 | sort | uniq -c
```

### **Recuperación de Errores / Error Recovery**

```bash
# Si API no responde / If API not responding
docker-compose restart nightclub-api

# Si BD está lenta / If database is slow
docker-compose restart postgres

# Si Redis tiene problemas / If Redis has issues
docker-compose restart redis

# Si todo falla / If everything fails
docker-compose down -v
docker-compose up -d
```

### **Registrar Errores / Log Errors**

```bash
# Crear reporte de error / Create error report
curl -X POST http://localhost:3000/api/errors/report \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "title": "Database connection timeout",
    "description": "Unable to connect to PostgreSQL",
    "severity": "high",
    "timestamp": "2024-01-15T23:30:00Z",
    "service": "nightclub-api",
    "stack_trace": "..."
  }'

# Ver errores reportados / View reported errors
curl "http://localhost:3000/api/errors?severity=high" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

---

## 🎯 CHECKLIST DE OPERACIONES / OPERATIONS CHECKLIST

### **Checklist Diario / Daily**

```
08:00 - [ ] Verificar estado de servicios / Check service status
08:30 - [ ] Verificar salud de API / Check API health
09:00 - [ ] Contar mesas disponibles / Count available tables
09:30 - [ ] Ver reservas del día / View today's reservations
12:00 - [ ] Verificar transacciones / Check transactions
15:00 - [ ] Hacer backup / Backup data
20:00 - [ ] Verificar propinas / Check tips
23:00 - [ ] Generar reporte diario / Generate daily report
03:00 - [ ] Cierre del club / Club closing procedures
```

### **Checklist Semanal / Weekly**

```
Lunes:
  - [ ] Revisar integridad de datos / Verify data integrity
  - [ ] Analizar métricas de la semana / Analyze metrics

Miércoles:
  - [ ] Actualizar dependencias / Update dependencies
  - [ ] Revisar seguridad / Security review

Viernes:
  - [ ] Optimizar base de datos / Optimize database
  - [ ] Revisar logs de errores / Review error logs

Domingo:
  - [ ] Backup completo / Full backup
  - [ ] Preparar para nueva semana / Prepare for new week
```

---

**© 2024 EV2 CLANDESTINOZ**

**Sistema completamente operacional. / Fully operational system.**

**Todos los derechos reservados. / All Rights Reserved.**

🚀 **¡Tu sistema está listo para operar 24/7! / Your system is ready to operate 24/7!** 🚀
