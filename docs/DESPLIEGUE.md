# Despliegue en un servidor — EV2 Clandestinoz

Cómo pasar de "corre en mi PC" a "corre en un servidor con dominio y HTTPS". Es la
**Fase 7** del plan.

Está escrito para un VPS de Hostinger porque el dominio ya vive ahí, pero sirve igual en
Hetzner, DigitalOcean o cualquier Ubuntu con Docker.

---

## Por qué no Firebase Hosting

Vale la pena dejarlo escrito para no volver a discutirlo dentro de seis meses.

Firebase Hosting sirve **archivos estáticos**. EV2 no lo es: necesita Node corriendo,
PostgreSQL, Redis y un WebSocket abierto. En Google Cloud saldría así: `web/` en Firebase
Hosting, la API en Cloud Run, la base en Cloud SQL y Redis en Memorystore — cuatro
servicios de pago, con una VPC de por medio, para lo que aquí corre con un
`docker compose`. Cloud Functions además no soporta WebSockets, así que el tiempo real
obliga a Cloud Run de todos modos.

Un VPS es una sola máquina, una sola factura y el **mismo** archivo de Docker que ya
usas en local.

---

## 1. El servidor

| Qué | Valor |
|---|---|
| Sistema | Ubuntu 24.04 LTS |
| Tamaño | 4 vCPU / 8 GB / 80 GB es lo que estima el plan. Para el piloto de una noche alcanza con la mitad. |
| Acceso | Llave SSH, **nunca** contraseña |

Entra por SSH y prepara la máquina:

```bash
# Un usuario que no sea root, con permiso de Docker.
adduser ev2
usermod -aG sudo ev2
rsync --archive --chown=ev2:ev2 ~/.ssh /home/ev2/

# Docker
curl -fsSL https://get.docker.com | sh
usermod -aG docker ev2

# Cortafuegos: solo SSH y web. La base y Redis NUNCA se abren.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Que no se pueda entrar con contraseña ni como root.
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

# Parches de seguridad solos.
apt update && apt install -y unattended-upgrades fail2ban
```

Reconéctate ya como `ev2`, no como root.

---

## 2. El dominio, en Hostinger

Panel de Hostinger → tu dominio → **Zona DNS**. Dos registros `A` apuntando a la IP del
VPS:

| Tipo | Nombre | Apunta a | TTL |
|---|---|---|---|
| A | `@` | IP del VPS | 300 |
| A | `www` | IP del VPS | 300 |

Si quieres un ambiente de pruebas aparte, agrega otro `A` con nombre `staging`.

**No hace falta un subdominio `api.`**: el contenedor `web` ya reenvía `/api` y `/ws`
desde el mismo origen. Eso además te ahorra configurar CORS entre dominios distintos,
que es de donde salen la mitad de los "Sin conexión".

Antes de seguir, comprueba que el DNS ya se propagó. Si esto no responde con tu IP,
**espera**: Let's Encrypt va a fallar y cada intento fallido cuenta contra su límite.

```bash
dig +short tudominio.com
```

---

## 3. El código y el `.env`

```bash
git clone <la-url-de-tu-repositorio> ~/ev2
cd ~/ev2
```

Genera **secretos nuevos**. Los de tu `.env` de desarrollo no sirven aquí: son de
desarrollo y ya circularon.

```bash
echo "DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')"
echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '/+=')"
echo "BANK_ENCRYPTION_KEY=$(openssl rand -base64 48 | tr -d '/+=')"
```

Crea `~/ev2/.env` con esto (sin comentarios en la misma línea que un valor — Compose
corta en el ` #` y el contenedor arranca con un secreto truncado):

```
DB_PASSWORD=lo-que-salio-arriba
JWT_SECRET=lo-que-salio-arriba
BANK_ENCRYPTION_KEY=lo-que-salio-arriba

EV2_DOMAIN=tudominio.com
ACME_EMAIL=un-correo-que-leas@ejemplo.com
ALLOWED_ORIGINS=https://tudominio.com

DB_NAME=ev2
LOG_LEVEL=info
```

```bash
chmod 600 .env
```

> ### `BANK_ENCRYPTION_KEY` se pone UNA vez y no se cambia
>
> Las cuentas bancarias de los empleados se guardan cifradas con esa llave. En cuanto el
> primer empleado registre la suya, cambiar la llave deja **todas** las cuentas
> ilegibles, sin forma de recuperarlas. Guárdala fuera del servidor —en tu gestor de
> contraseñas— el mismo día que la generes.

---

## 4. Levantar

```bash
cd ~/ev2
docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d --build
```

La primera vez tarda unos minutos: construye las imágenes y Caddy pide el certificado.

Comprueba:

```bash
docker compose --env-file .env -f deploy/docker-compose.prod.yml ps
curl -sI https://tudominio.com | head -3
```

Si Caddy no consiguió el certificado, lo dice claro:

```bash
docker compose --env-file .env -f deploy/docker-compose.prod.yml logs caddy | tail -30
```

Casi siempre es una de dos: el DNS todavía no apunta al servidor, o el puerto 80 está
cerrado. Let's Encrypt **necesita** el 80 aunque el sitio final sea HTTPS.

---

## 5. Crear el club y el primer gerente

Aquí es donde un servidor nuevo se atora si no se sabe esto:

- `npm run seed` **se niega** a correr con `NODE_ENV=production`, y hace bien: crea
  cuentas de prueba con una contraseña conocida.
- `/auth/register` siempre da de alta un **invitado**, nunca un gerente.

Para eso existe `npm run bootstrap`. Crea el club y **un** gerente, nada más — ni mesas,
ni tragos, ni personal de ejemplo:

```bash
docker compose --env-file .env -f deploy/docker-compose.prod.yml exec \
  -e CLUB_NAME="EV2 Clandestinoz" \
  -e CLUB_SLUG=ev2 \
  -e CLUB_CITY="Tu ciudad" \
  -e MANAGER_EMAIL=dueno@tucorreo.com \
  -e MANAGER_NAME="Nombre Apellido" \
  -e MANAGER_BIRTH_DATE=1985-04-23 \
  api npm run bootstrap
```

Imprime una contraseña temporal **una sola vez**, de cuatro palabras para que se pueda
dictar por teléfono sin deletrear. Cópiala antes de cerrar la terminal. Al entrar, el
sistema obliga a cambiarla.

El script **se niega a correr si el club ya tiene un gerente**. Es a propósito: si no,
cualquiera con acceso a la terminal del servidor se haría gerente del club. Para dar de
alta al resto del personal se usa la pantalla del gerente.

Si el slug que usaste **no** es `ev2`, cámbialo en las páginas antes de construir:

```bash
grep -rl 'name="ev2:club"' web/ | xargs sed -i 's/content="ev2"/content="tu-slug"/'
```

### Cargar el club de verdad

El plano de mesas y la lista de precios sí son datos reales del club, y esos se cargan
con sus propios comandos:

```bash
docker compose --env-file .env -f deploy/docker-compose.prod.yml exec api npm run seed:floor
docker compose --env-file .env -f deploy/docker-compose.prod.yml exec api npm run seed:prices
```

`seed:prices` no es opcional: sin él ninguna mesa tiene precio y la pantalla de
reservación sale vacía sin explicar por qué.

---

## 6. Respaldos

Un sistema que guarda propinas y cuentas bancarias sin respaldo probado no está
desplegado, está apostado.

```bash
mkdir -p ~/respaldos
cat > ~/respaldar.sh <<'EOF'
#!/bin/bash
set -euo pipefail
cd ~/ev2
STAMP=$(date +%F-%H%M)
docker compose --env-file .env -f deploy/docker-compose.prod.yml exec -T postgres \
  pg_dump -U postgres ev2 | gzip > ~/respaldos/ev2-$STAMP.sql.gz
# 30 días de retención.
find ~/respaldos -name 'ev2-*.sql.gz' -mtime +30 -delete
EOF
chmod +x ~/respaldar.sh

# Todos los días a las 6 de la mañana, cuando el club ya cerró.
(crontab -l 2>/dev/null; echo "0 6 * * * /home/ev2/respaldar.sh") | crontab -
```

**Un respaldo que nunca se restauró no es un respaldo.** Una vez al mes, restaura el
último en una base de prueba y confirma que abre:

```bash
gunzip -c ~/respaldos/ev2-XXXX.sql.gz | docker compose --env-file .env \
  -f deploy/docker-compose.prod.yml exec -T postgres psql -U postgres -d postgres \
  -c 'CREATE DATABASE prueba_restauracion' -c '\c prueba_restauracion' -f -
```

Y **sácalos del servidor**. Un respaldo que vive en la misma máquina que la base no
protege del único caso que importa: perder la máquina.

---

## 7. Actualizar

```bash
cd ~/ev2
git pull
docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d --build
```

Las migraciones se aplican solas al arrancar la API. Antes de actualizar en un servidor
con datos reales, **respalda primero**:

```bash
~/respaldar.sh && git pull && docker compose --env-file .env \
  -f deploy/docker-compose.prod.yml up -d --build
```

---

## 8. Ver qué pasa

```bash
# Todo
docker compose --env-file .env -f deploy/docker-compose.prod.yml logs -f --tail=50

# Solo la API
docker compose --env-file .env -f deploy/docker-compose.prod.yml logs -f api

# Salud
curl -s https://tudominio.com/api/health
```

Para conectarte a la base con un cliente SQL desde tu máquina, **túnel SSH**, no abrir el
puerto:

```bash
ssh -L 5432:localhost:5432 ev2@IP-DEL-SERVIDOR
# y en el túnel, dentro del servidor:
docker compose --env-file .env -f deploy/docker-compose.prod.yml exec postgres psql -U postgres ev2
```

---

## Antes de que entre gente de verdad

Esto no es burocracia; es lo que separa un piloto de un problema.

- [ ] Secretos de producción **nuevos**, distintos a los de desarrollo.
- [ ] `BANK_ENCRYPTION_KEY` guardada fuera del servidor.
- [ ] `ALLOWED_ORIGINS` con el dominio real y `https://`.
- [ ] Ninguna cuenta del seed de desarrollo en la base (`guest@ev2.local` y compañía).
- [ ] Postgres y Redis sin puerto publicado — el archivo de producción ya lo garantiza,
      solo no le agregues el override de desarrollo.
- [ ] Respaldo diario corriendo **y** una restauración probada.
- [ ] HTTPS funcionando y renovación automática (la hace Caddy).
- [ ] Monitoreo de `/api/health` con alerta (Uptime Kuma o Better Uptime).

Y dos que no son técnicas y siguen pendientes en la **Fase 8**: el sistema guarda
nombres, teléfonos y cuentas bancarias del personal. Antes de abrirlo a clientes reales
hacen falta el **aviso de privacidad** y los **términos**. Para un piloto interno con tu
propia gente, avisada, no es problema.

---

## Si algo falla

| Síntoma | Casi siempre es |
|---|---|
| "Sin conexión" al entrar | `ALLOWED_ORIGINS` no coincide con la dirección de la barra. Tiene que ser idéntica, con `https://` y sin barra final. |
| El navegador desconfía del certificado | Caddy no pudo emitirlo: revisa que el DNS apunte al servidor y que el puerto 80 esté abierto. |
| `ev2-api` reiniciándose en bucle | Un secreto vacío o truncado en `.env`. Revisa que ningún valor lleve un `#` en la misma línea. |
| La app dice "Conectando…" para siempre | El contenedor `ws` no levantó: `logs ws`. |
| La pantalla de reservación sale vacía | Falta `npm run seed:prices`. |
| `bootstrap` dice "ya tiene gerente" | Correcto y a propósito. Entra con el gerente que ya existe. |
