# 🚀 GUÍA DE DESPLIEGUE Y EJECUCIÓN DEL SISTEMA EV2 CLANDESTINOZ
# 🚀 EV2 CLANDESTINOZ SYSTEM DEPLOYMENT & EXECUTION GUIDE

**© 2024 EV2 CLANDESTINOZ - All Rights Reserved**

---

## 📋 TABLA DE CONTENIDOS / TABLE OF CONTENTS

1. [Requisitos Previos / Prerequisites](#requisitos-previos)
2. [Instalación Local / Local Installation](#instalación-local)
3. [Configuración / Configuration](#configuración)
4. [Ejecución / Running](#ejecución)
5. [Despliegue en Producción / Production Deployment](#despliegue-en-producción)
6. [Testing / Pruebas](#testing)
7. [Troubleshooting / Solución de Problemas](#troubleshooting)
8. [Monitoreo / Monitoring](#monitoreo)
9. [Actualizaciones / Updates](#actualizaciones)

---

## 📦 REQUISITOS PREVIOS / PREREQUISITES

### **Mínimos / Minimum Requirements**

```
Sistema Operativo / Operating System:
✅ Windows 10+ / macOS 10.15+ / Linux (Ubuntu 20.04+)

RAM:
✅ Mínimo 4GB / Minimum 4GB
✅ Recomendado 8GB+ / Recommended 8GB+

Espacio en Disco / Disk Space:
✅ Mínimo 10GB / Minimum 10GB
✅ Recomendado 20GB+ / Recommended 20GB+

Conexión / Connection:
✅ Internet de banda ancha / Broadband internet
✅ Velocidad mínima: 10 Mbps / Minimum speed: 10 Mbps
```

### **Software Requerido / Required Software**

```
DESARROLLO / DEVELOPMENT:
1. Git (v2.30+)
   Descargar / Download: https://git-scm.com/

2. Node.js (v16+ LTS)
   Descargar / Download: https://nodejs.org/
   Incluye / Includes: npm

3. Docker (v20.10+)
   Descargar / Download: https://docker.com/
   Incluye / Includes: Docker Compose

4. Visual Studio Code (opcional / optional)
   Descargar / Download: https://code.visualstudio.com/

PARA iOS / FOR iOS:
5. Xcode (macOS solamente / macOS only)
   Descargar / Download: App Store

PARA ANDROID / FOR ANDROID:
6. Android Studio
   Descargar / Download: https://developer.android.com/studio

BASES DE DATOS / DATABASES:
7. PostgreSQL (v13+) O / OR
8. MongoDB (v5.0+)

SERVICIOS EXTERNOS / EXTERNAL SERVICES:
9. Stripe (para pagos / for payments)
10. Mercado Pago (para México / for Mexico)
11. Twilio (para SMS / for SMS)
12. AWS S3 (para almacenamiento / for storage) - opcional
```

### **Verificar Instalación / Verify Installation**

```bash
# Verificar Node.js
node --version          # Debe ser v16+
npm --version          # Debe ser v7+

# Verificar Git
git --version          # Debe ser v2.30+

# Verificar Docker
docker --version       # Debe ser v20.10+
docker-compose --version

# Verificar PostgreSQL (si está instalado)
psql --version
```

---

## 💾 INSTALACIÓN LOCAL / LOCAL INSTALLATION

### **PASO 1: Clonar Repositorio / Clone Repository**

```bash
# Crear carpeta de proyecto / Create project folder
mkdir ev2-clandestinoz
cd ev2-clandestinoz

# Clonar código / Clone code
git clone https://github.com/ev2clandestinoz/platform.git .

# Verifica archivos / Verify files
ls -la

# Deberías ver / You should see:
# - server/ (backends)
# - web/ (aplicaciones web)
# - ios/ (aplicación iOS)
# - android/ (aplicación Android)
# - docs/ (documentación)
# - docker-compose.yml
# - .env.example
```

### **PASO 2: Instalar Dependencias / Install Dependencies**

```bash
# Backend - API Principal / Main API
cd server/nightclub-api
npm install
cd ../..

# Backend - API de Reservas / Reservations API
cd server/reservations-api
npm install
cd ../..

# Backend - Sistema de Precios / Pricing System
cd server/pricing-system
npm install
cd ../..

# Backend - Gestor de Pista / Dance Floor Manager
cd server/dance-floor-manager
npm install
cd ../..

# Backend - Sistema de Flirteo / Flirt System
cd server/flirt-system
npm install
cd ../..

# Backend - Sistema de Taxi / Taxi System
cd server/taxi-system
npm install
cd ../..

# Backend - Sistema de Propinas / Tip System
cd server/tip-dancer-system
npm install
cd ../..

# Backend - Sistema de Empleados / Employee System
cd server/employee-account-system
npm install
cd ../..

# Backend - Integración POS / POS Integration
cd server/pos-integration-system
npm install
cd ../..

# Backend - Sistema de Valet / Valet Parking
cd server/valet-parking-system
npm install
cd ../..
```

### **PASO 3: Configurar Variables de Entorno / Setup Environment Variables**

```bash
# Copiar template de configuración / Copy config template
cp .env.example .env

# Editar .env con tus valores / Edit .env with your values
nano .env    # Linux/macOS
# O / OR
notepad .env # Windows
```

### **Contenido de .env / .env Content**

```env
# === APLICACIÓN / APPLICATION ===
NODE_ENV=development
PORT=3000
HOST=localhost
LOG_LEVEL=debug

# === BASE DE DATOS / DATABASE ===
# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=ev2_clandestinoz
DB_USER=ev2_user
DB_PASSWORD=SecurePassword123!
DB_SSL=false

# O MongoDB (descomentar si usas MongoDB)
# MONGODB_URI=mongodb://localhost:27017/ev2_clandestinoz

# === AUTENTICACIÓN / AUTHENTICATION ===
JWT_SECRET=your-super-secret-jwt-key-change-this
JWT_EXPIRE=7d
REFRESH_TOKEN_SECRET=your-refresh-token-secret
REFRESH_TOKEN_EXPIRE=30d

# === OAUTH 2.0 ===
OAUTH_CLIENT_ID=your-oauth-client-id
OAUTH_CLIENT_SECRET=your-oauth-client-secret
OAUTH_REDIRECT_URL=http://localhost:3000/auth/callback

# === PAGOS / PAYMENTS ===
STRIPE_PUBLIC_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

MERCADO_PAGO_ACCESS_TOKEN=TEST-...
MERCADO_PAGO_PUBLIC_KEY=TEST-...

# === SERVICIOS / SERVICES ===
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...

# === ALMACENAMIENTO / STORAGE ===
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_S3_BUCKET=ev2-clandestinoz
AWS_REGION=us-east-1

# === MAPAS / MAPS ===
GOOGLE_MAPS_API_KEY=AIza...
GOOGLE_MAPS_SECRET=...

# === SERVICIOS DE TAXI / TAXI SERVICES ===
UBER_API_KEY=...
LYFT_API_KEY=...
DIDI_API_KEY=...
CABIFY_API_KEY=...

# === MONEDAS / CURRENCIES ===
DEFAULT_CURRENCY=MXN
EXCHANGE_RATE_API_KEY=...

# === CLUB / CLUB ===
CLUB_NAME=EV2 Clandestinoz
CLUB_CITY=Nogales
CLUB_COUNTRY=Mexico
CLUB_LATITUDE=31.9454
CLUB_LONGITUDE=-110.9663
CLUB_PHONE=+52-641-314-0000
CLUB_EMAIL=info@ev2clandestinoz.com

# === ADMINISTRADOR / ADMIN ===
ADMIN_EMAIL=admin@ev2clandestinoz.com
ADMIN_PASSWORD=AdminPassword123!

# === MODO DEBUG / DEBUG MODE ===
DEBUG=true
VERBOSE=true
```

### **PASO 4: Configurar Base de Datos / Setup Database**

**Opción A: PostgreSQL**

```bash
# Crear base de datos / Create database
createdb ev2_clandestinoz

# Ejecutar migraciones / Run migrations
npm run migrate:latest

# Llenar datos de prueba / Seed test data
npm run seed:dev
```

**Opción B: MongoDB**

```bash
# MongoDB se inicia automáticamente en Docker
# MongoDB starts automatically in Docker
docker-compose up -d mongodb

# Ejecutar migraciones / Run migrations
npm run migrate:mongo

# Llenar datos de prueba / Seed test data
npm run seed:dev:mongo
```

---

## 🐳 INSTALACIÓN CON DOCKER / DOCKER INSTALLATION

### **Opción Recomendada / Recommended Option**

```bash
# Construir todas las imágenes / Build all images
docker-compose build

# Iniciar todos los servicios / Start all services
docker-compose up -d

# Verificar que todo esté corriendo / Verify all running
docker-compose ps

# Ver logs / View logs
docker-compose logs -f

# Detener servicios / Stop services
docker-compose down
```

### **Contenido de docker-compose.yml / docker-compose.yml Content**

```yaml
version: '3.8'

services:
  # Base de Datos / Database
  postgres:
    image: postgres:13-alpine
    environment:
      POSTGRES_DB: ev2_clandestinoz
      POSTGRES_USER: ev2_user
      POSTGRES_PASSWORD: SecurePassword123!
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ev2_user"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Redis (Cache)
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  # API Principal / Main API
  nightclub-api:
    build: ./server/nightclub-api
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: development
      PORT: 3000
      DB_HOST: postgres
      REDIS_HOST: redis
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    volumes:
      - ./server/nightclub-api:/app
      - /app/node_modules
    command: npm run dev

  # API de Reservas / Reservations API
  reservations-api:
    build: ./server/reservations-api
    ports:
      - "3001:3001"
    environment:
      NODE_ENV: development
      PORT: 3001
      DB_HOST: postgres
      REDIS_HOST: redis
    depends_on:
      - postgres
      - redis

  # Sistema de Precios / Pricing System
  pricing-system:
    build: ./server/pricing-system
    ports:
      - "3002:3002"
    environment:
      NODE_ENV: development
      PORT: 3002
      DB_HOST: postgres
    depends_on:
      - postgres

  # Sistema de Taxi / Taxi System
  taxi-system:
    build: ./server/taxi-system
    ports:
      - "3003:3003"
    environment:
      NODE_ENV: development
      PORT: 3003
      DB_HOST: postgres
    depends_on:
      - postgres

  # Sistema de Propinas / Tip System
  tip-system:
    build: ./server/tip-dancer-system
    ports:
      - "3004:3004"
    environment:
      NODE_ENV: development
      PORT: 3004
      DB_HOST: postgres
      REDIS_HOST: redis
    depends_on:
      - postgres
      - redis

  # Sistema de Empleados / Employee System
  employee-system:
    build: ./server/employee-account-system
    ports:
      - "3005:3005"
    environment:
      NODE_ENV: development
      PORT: 3005
      DB_HOST: postgres
    depends_on:
      - postgres

  # Sistema de Flirteo / Flirt System
  flirt-system:
    build: ./server/flirt-system
    ports:
      - "3006:3006"
    environment:
      NODE_ENV: development
      PORT: 3006
      DB_HOST: postgres
      REDIS_HOST: redis
    depends_on:
      - postgres
      - redis

  # Sistema de Valet / Valet Parking
  valet-system:
    build: ./server/valet-parking-system
    ports:
      - "3007:3007"
    environment:
      NODE_ENV: development
      PORT: 3007
      DB_HOST: postgres
    depends_on:
      - postgres

  # Nginx (Proxy Inverso / Reverse Proxy)
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl:/etc/nginx/ssl:ro
    depends_on:
      - nightclub-api
      - reservations-api
      - pricing-system
      - taxi-system
      - tip-system
      - employee-system
      - flirt-system
      - valet-system

  # Aplicación Web / Web Application
  web-app:
    image: nginx:alpine
    ports:
      - "8080:80"
    volumes:
      - ./web/dist:/usr/share/nginx/html:ro
    depends_on:
      - nightclub-api

volumes:
  postgres_data:
  redis_data:

networks:
  default:
    name: ev2-network
```

---

## ⚙️ CONFIGURACIÓN / CONFIGURATION

### **Archivos de Configuración Importantes / Important Config Files**

```
config/
├── database.js
│   └─ Configuración de BD / Database config
├── auth.js
│   └─ Configuración de autenticación / Auth config
├── payment.js
│   └─ Configuración de pagos / Payment config
├── taxi-services.js
│   └─ Configuración de taxis / Taxi services config
├── storage.js
│   └─ Configuración de almacenamiento / Storage config
└── currencies.js
    └─ Configuración de monedas / Currencies config
```

### **Ejemplo: database.js**

```javascript
module.exports = {
  development: {
    client: 'pg',
    connection: {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'ev2_clandestinoz',
      user: process.env.DB_USER || 'ev2_user',
      password: process.env.DB_PASSWORD || 'password',
      ssl: process.env.DB_SSL === 'true'
    },
    migrations: {
      directory: './migrations'
    },
    seeds: {
      directory: './seeds'
    }
  },

  production: {
    client: 'pg',
    connection: {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: true
    },
    pool: {
      min: 2,
      max: 10
    },
    migrations: {
      directory: './migrations'
    }
  }
};
```

---

## 🚀 EJECUCIÓN / RUNNING

### **Desarrollo Local / Local Development**

```bash
# Terminal 1: Base de datos / Database
docker run -d -p 5432:5432 \
  -e POSTGRES_DB=ev2_clandestinoz \
  -e POSTGRES_USER=ev2_user \
  -e POSTGRES_PASSWORD=password \
  postgres:13-alpine

# Terminal 2: API Principal / Main API
cd server/nightclub-api
npm run dev
# Server corriendo en / Server running on http://localhost:3000

# Terminal 3: Aplicación Web / Web App
cd web
npm run serve
# Web app corriendo en / running on http://localhost:8080

# Terminal 4: Monitorear logs / Monitor logs
docker logs -f <container_id>
```

### **Todos los Servicios con Docker / All Services with Docker**

```bash
# Inicia todo / Start everything
docker-compose up -d

# Verifica estado / Check status
docker-compose ps

# Ver logs de un servicio / View service logs
docker-compose logs nightclub-api

# Ver logs en vivo / Live logs
docker-compose logs -f

# Ejecutar comando en contenedor / Run command in container
docker-compose exec nightclub-api npm run migrate

# Detener todo / Stop everything
docker-compose down

# Detener y limpiar volúmenes / Stop and remove volumes
docker-compose down -v
```

### **URLs Locales / Local URLs**

```
Aplicación Web / Web App:        http://localhost:8080
API Principal / Main API:        http://localhost:3000
API de Reservas / Reservations:  http://localhost:3001
Sistema de Precios / Pricing:    http://localhost:3002
Sistema de Taxi / Taxi:          http://localhost:3003
Sistema de Propinas / Tips:      http://localhost:3004
Sistema de Empleados / Employee: http://localhost:3005
Sistema de Flirteo / Flirt:      http://localhost:3006
Sistema de Valet / Valet:        http://localhost:3007

Base de Datos / Database:
  Host: localhost
  Port: 5432
  User: ev2_user
  Database: ev2_clandestinoz

Redis Cache:
  Host: localhost
  Port: 6379
```

### **Credenciales de Prueba / Test Credentials**

```
Admin Account / Cuenta Administrador:
  Email: admin@ev2clandestinoz.com
  Password: AdminPassword123!
  Role: Administrator

Staff Account / Cuenta de Personal:
  Email: staff@ev2clandestinoz.com
  Password: StaffPassword123!
  Role: Staff

Guest Account / Cuenta de Invitado:
  Email: guest@ev2clandestinoz.com
  Password: GuestPassword123!
  Role: Guest
```

---

## 🌍 DESPLIEGUE EN PRODUCCIÓN / PRODUCTION DEPLOYMENT

### **Opción 1: AWS EC2**

```bash
# 1. Crear instancia EC2
# - Ubuntu 20.04 LTS
# - t3.xlarge (4 vCPU, 16GB RAM)
# - 50GB SSD

# 2. Conectar por SSH
ssh -i your-key.pem ubuntu@your-instance-ip

# 3. Instalar dependencias
sudo apt update
sudo apt install -y curl wget git
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker ubuntu

# 4. Clonar repositorio
git clone https://github.com/ev2clandestinoz/platform.git
cd platform

# 5. Configurar variables de entorno
nano .env.production

# 6. Ejecutar con Docker Compose
docker-compose -f docker-compose.prod.yml up -d

# 7. Configurar SSL con Let's Encrypt
sudo apt install -y certbot python3-certbot-nginx
sudo certbot certonly -d yourdomain.com
```

### **Opción 2: Google Cloud Run**

```bash
# 1. Autenticar con Google Cloud
gcloud auth login
gcloud config set project your-project-id

# 2. Construir imagen
gcloud builds submit --tag gcr.io/your-project/ev2-api

# 3. Desplegar servicio
gcloud run deploy ev2-api \
  --image gcr.io/your-project/ev2-api:latest \
  --platform managed \
  --region us-central1 \
  --memory 2Gi \
  --env-vars-file .env.production

# 4. Acceder
curl https://ev2-api-[random].a.run.app/api/health
```

### **Opción 3: Heroku**

```bash
# 1. Instalar Heroku CLI
curl https://cli.heroku.com/install.sh | sh

# 2. Login
heroku login

# 3. Crear app
heroku create ev2-clandestinoz-api

# 4. Agregar base de datos
heroku addons:create heroku-postgresql:standard-0

# 5. Configurar variables
heroku config:set NODE_ENV=production
heroku config:set JWT_SECRET=your-secret

# 6. Deploy
git push heroku main

# 7. Verificar
heroku logs --tail
```

### **Checklist de Producción / Production Checklist**

```
SEGURIDAD / SECURITY:
✅ HTTPS/SSL configurado / Configured
✅ Firewall habilitado / Enabled
✅ Contraseñas fuertes / Strong passwords
✅ Datos sensibles en variables / Sensitive data in env vars
✅ CORS configurado / Configured
✅ Rate limiting habilitado / Enabled
✅ SQL injection prevention / Prevención de inyección

RENDIMIENTO / PERFORMANCE:
✅ CDN configurado / Configured
✅ Cache habilitado / Enabled
✅ Compresión de respuestas / Response compression
✅ Minificación de assets / Asset minification
✅ Database indexing / Indexación de BD
✅ Connection pooling / Pool de conexiones

MONITOREO / MONITORING:
✅ Logs centralizados / Centralized logging
✅ Error tracking / Seguimiento de errores
✅ Alerts configuradas / Alerts configured
✅ Health checks / Verificación de salud
✅ Uptime monitoring / Monitoreo de tiempo activo

BACKUP / BACKUPS:
✅ Daily backups / Copias diarias
✅ Offsite storage / Almacenamiento externo
✅ Backup testing / Pruebas de respaldo
✅ Recovery plan / Plan de recuperación

ESCALABILIDAD / SCALABILITY:
✅ Load balancing / Balanceo de carga
✅ Auto-scaling / Escalado automático
✅ Database replication / Replicación de BD
✅ Microservices architecture / Arquitectura de microservicios
```

---

## ✅ TESTING / PRUEBAS

### **Unit Tests**

```bash
# Ejecutar todas las pruebas / Run all tests
npm test

# Pruebas con cobertura / Tests with coverage
npm run test:coverage

# Pruebas de un servicio / Tests for specific service
npm test -- server/nightclub-api

# Modo watch / Watch mode
npm run test:watch
```

### **Integration Tests**

```bash
# Ejecutar pruebas de integración / Run integration tests
npm run test:integration

# Con reporte / With report
npm run test:integration -- --reporter=html
```

### **API Tests con Postman**

```bash
# Importar colección / Import collection
# Archivo / File: ./tests/postman/EV2-Clandestinoz.postman_collection.json

# Ejecutar con Newman
npm install -g newman
newman run ./tests/postman/EV2-Clandestinoz.postman_collection.json \
  -e ./tests/postman/development.postman_environment.json
```

### **Load Testing**

```bash
# Instalar Apache Bench / Install Apache Bench
# macOS: brew install httpd
# Ubuntu: sudo apt install apache2-utils

# Prueba simple / Simple load test
ab -n 1000 -c 100 http://localhost:3000/api/health

# Con herramienta profesional / With pro tool
npm install -g autocannon
autocannon -c 100 -d 30 http://localhost:3000/api/tables
```

---

## 🔧 TROUBLESHOOTING / SOLUCIÓN DE PROBLEMAS

### **Problema: Puerto ya está en uso / Port already in use**

```bash
# Encontrar proceso usando puerto / Find process using port
lsof -i :3000       # macOS/Linux
netstat -ano | findstr :3000 # Windows

# Matar proceso / Kill process
kill -9 <PID>       # macOS/Linux
taskkill /PID <PID> /F # Windows

# O usar diferente puerto / Or use different port
PORT=3001 npm run dev
```

### **Problema: Error de conexión a BD / Database connection error**

```bash
# Verificar que PostgreSQL está corriendo / Verify PostgreSQL running
docker-compose logs postgres

# Reiniciar base de datos / Restart database
docker-compose restart postgres

# Recrear volumen / Recreate volume
docker-compose down -v
docker-compose up -d postgres

# Verificar credenciales / Verify credentials
psql -h localhost -U ev2_user -d ev2_clandestinoz
```

### **Problema: Módulos no encontrados / Module not found**

```bash
# Limpiar y reinstalar / Clean and reinstall
rm -rf node_modules package-lock.json
npm install

# Específicamente en cada servicio / Specifically in each service
cd server/nightclub-api
rm -rf node_modules package-lock.json
npm install
```

### **Problema: API lenta / Slow API**

```bash
# Ver uso de recursos / Check resource usage
docker stats

# Revisar logs para errores / Check logs for errors
docker-compose logs --tail=100 nightclub-api

# Aumentar recursos / Increase resources
# Editar docker-compose.yml:
# services:
#   nightclub-api:
#     deploy:
#       resources:
#         limits:
#           cpus: '2'
#           memory: 2G
```

### **Problema: Aplicación web no carga / Web app won't load**

```bash
# Verificar que servidor web esté corriendo / Verify web server running
docker-compose logs nginx

# Verificar que archivos existen / Verify files exist
ls -la web/dist/

# Reconstruir aplicación web / Rebuild web app
cd web
npm run build
docker-compose restart web-app

# Verificar CORS / Verify CORS
curl -H "Origin: http://localhost:8080" \
     -H "Access-Control-Request-Method: GET" \
     http://localhost:3000/api/health
```

---

## 📊 MONITOREO / MONITORING

### **Logs Centralizados / Centralized Logging**

```bash
# Ver logs de todos los servicios / View logs from all services
docker-compose logs

# Últimas 100 líneas / Last 100 lines
docker-compose logs --tail=100

# Logs en vivo / Live logs
docker-compose logs -f

# Específico de un servicio / Specific service
docker-compose logs -f nightclub-api
```

### **Métricas con Prometheus**

```bash
# Acceder a Prometheus / Access Prometheus
http://localhost:9090

# Queries disponibles / Available queries:
# - container_memory_usage_bytes
# - container_cpu_usage_seconds_total
# - up{job="docker"}
```

### **Visualización con Grafana**

```bash
# Acceder a Grafana / Access Grafana
http://localhost:3000

# Credenciales por defecto / Default credentials:
# Admin: admin / admin

# Dashboards pre-configurados / Pre-configured dashboards:
# - System Performance
# - Application Metrics
# - Database Performance
```

### **Alertas y Notificaciones / Alerts & Notifications**

```
Configurar en Grafana / Configure in Grafana:

1. Ir a Alerting / Go to Alerting
2. Click "New Alert Policy"
3. Seleccionar métrica / Select metric
4. Establecer umbral / Set threshold
5. Configura notificación / Configure notification:
   - Email
   - Slack
   - PagerDuty
   - Webhook
```

### **Health Checks / Verificación de Salud**

```bash
# Verificar salud de API / Check API health
curl http://localhost:3000/api/health

# Respuesta esperada / Expected response:
{
  "status": "ok",
  "timestamp": "2024-01-15T23:30:00Z",
  "uptime": 3600,
  "services": {
    "database": "connected",
    "redis": "connected",
    "payment": "connected"
  }
}

# Health check en todos los servicios / Health check all services
for port in 3000 3001 3002 3003 3004 3005 3006 3007; do
  echo "Puerto / Port $port:"
  curl -s http://localhost:$port/api/health | jq .
done
```

---

## 🔄 ACTUALIZACIONES / UPDATES

### **Actualizar Código / Update Code**

```bash
# Obtener últimos cambios / Get latest changes
git pull origin main

# Reinstalar dependencias si fue necesario / Reinstall dependencies if needed
npm install

# Ejecutar migraciones / Run migrations
npm run migrate:latest

# Reiniciar servicios / Restart services
docker-compose restart
```

### **Actualizar Dependencias / Update Dependencies**

```bash
# Ver qué se puede actualizar / Check what can be updated
npm outdated

# Actualizar a versiones menores / Update to minor versions
npm update

# Actualizar a versiones mayores (cuidadoso) / Major versions (careful)
npm audit
npm upgrade
```

### **Backup Antes de Actualizar / Backup Before Update**

```bash
# Backup de base de datos / Database backup
docker-compose exec postgres pg_dump -U ev2_user ev2_clandestinoz > backup_$(date +%Y%m%d).sql

# Backup de datos / Data backup
tar -czf backup_data_$(date +%Y%m%d).tar.gz ./data/

# Guardar en lugar seguro / Save to safe location
mv backup_*.sql /backup/
mv backup_*.tar.gz /backup/
```

### **Rollback a Versión Anterior / Rollback to Previous Version**

```bash
# Ver historial / Check history
git log --oneline

# Volver a versión anterior / Go to previous version
git checkout <commit-hash>

# Reconstruir imagen / Rebuild image
docker-compose build --no-cache

# Reiniciar servicios / Restart services
docker-compose up -d
```

---

## 📱 DESPLIEGUE DE APPS MÓVILES / MOBILE APPS DEPLOYMENT

### **iOS (App Store)**

```bash
# 1. Abrir en Xcode
open ios/EV2Clandestinoz.xcworkspace

# 2. Configurar Team ID
# En Xcode: Project > Signing & Capabilities

# 3. Crear release build
xcodebuild -workspace ios/EV2Clandestinoz.xcworkspace \
  -scheme EV2Clandestinoz \
  -configuration Release \
  -archivePath ./build/EV2Clandestinoz.xcarchive \
  archive

# 4. Exportar para App Store
xcodebuild -exportArchive \
  -archivePath ./build/EV2Clandestinoz.xcarchive \
  -exportOptionsPlist ./build/ExportOptions.plist \
  -exportPath ./build/

# 5. Subir a App Store Connect
# En Xcode: Window > Organizer > Upload
```

### **Android (Play Store)**

```bash
# 1. Crear keystore
keytool -genkey -v -keystore release.keystore \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias ev2_release

# 2. Configurar gradle.properties
echo "storeFile=./release.keystore" > android/keystore.properties
echo "storePassword=your-password" >> android/keystore.properties
echo "keyAlias=ev2_release" >> android/keystore.properties
echo "keyPassword=your-password" >> android/keystore.properties

# 3. Build APK
cd android
./gradlew assembleRelease

# 4. Build AAB para Play Store
./gradlew bundleRelease

# 5. El archivo está en:
# build/outputs/apk/release/app-release.apk
# build/outputs/bundle/release/app.aab

# 6. Subir a Google Play Console
# Via web: https://play.google.com/console
```

---

## 🎯 PRÓXIMOS PASOS / NEXT STEPS

```
Semana 1 / Week 1:
✅ Instalar todo localmente / Install everything locally
✅ Ejecutar pruebas / Run tests
✅ Familiarizarse con arquitectura / Familiarize with architecture

Semana 2 / Week 2:
✅ Configurar producción / Setup production
✅ Desplegar en servidor de pruebas / Deploy to staging
✅ Pruebas de carga / Load testing

Semana 3 / Week 3:
✅ Desplegar en producción / Deploy to production
✅ Configurar monitoreo / Setup monitoring
✅ Establecer alertas / Setup alerts

Semana 4 / Week 4:
✅ Desplegar apps móviles / Deploy mobile apps
✅ Testing en producción / Production testing
✅ Optimizaciones / Optimizations
```

---

## 📞 SOPORTE / SUPPORT

```
Problemas Técnicos / Technical Issues:
Email: support@ev2clandestinoz.com
Slack: #technical-support
Horas / Hours: 24/7

Documentación / Documentation:
https://docs.ev2clandestinoz.com

API Documentation:
https://api.ev2clandestinoz.com/docs

Status Page:
https://status.ev2clandestinoz.com
```

---

**© 2024 EV2 CLANDESTINOZ**

**Sistema completo listo para desplegar. / Complete system ready to deploy.**

**Todos los derechos reservados. / All Rights Reserved.**

🚀 **¡Tu plataforma está lista para conquistar el mundo! / Your platform is ready to conquer the world!** 🚀
