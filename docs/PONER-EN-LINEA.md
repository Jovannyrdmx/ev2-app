# Poner esto en línea — lista de una sola pasada

`docs/DESPLIEGUE.md` es la referencia completa del servidor. Este archivo es más
corto y sirve para otra cosa: **la lista exacta de lo que falta hoy**, en orden, con
lo que hay que ver en cada paso para saber si funcionó.

La rama `fase5/inventario-por-barra` lleva **tres commits** sin subir:

| Commit | Qué trae |
|---|---|
| `e2f4c95` | Venta directa en la barra y el editor de recetas del gerente |
| `09ee7d1` | Un pase firmado por invitado, y la identificación antes del escaneo |
| `e95772b` | `/api/health` alcanzable desde fuera, `TRUST_PROXY_HOPS=2`, y dos herramientas de diagnóstico |

---

## 1. Subir la rama (desde tu máquina, no desde el servidor)

El servidor lee de GitHub, así que mientras la rama no esté ahí el `git pull` no
trae nada — y eso es lo que hacía que `seed:supplies` "no existiera".

```bash
cd C:\Users\rdjov\Documents\EV2-app
git push -u origin fase5/inventario-por-barra
```

**Cuidado con el nombre:** termina en `barra`, con `a`. Cópialo de aquí.

---

## 2. Traer el código al servidor

```bash
ssh ev2@45.93.100.244        # o el usuario que uses
cd ~/ev2-app

~/respaldar.sh               # primero el respaldo, siempre

git fetch origin
git checkout fase5/inventario-por-barra
git log --oneline -1         # TIENE que decir e95772b
```

Si no dice `e95772b`, el paso 1 no llegó. No sigas.

---

## 3. Revisar el `.env`

```bash
grep -E '^(EV2_DOMAIN|ACME_EMAIL|ALLOWED_ORIGINS)=' .env
```

Los tres son obligatorios y el contenedor se niega a arrancar sin ellos:

```
EV2_DOMAIN=ev2.systems                 # sin https://, sin barra final
ACME_EMAIL=un-correo-que-leas@...      # ahí avisa Let's Encrypt
ALLOWED_ORIGINS=https://ev2.systems    # CON https, sin barra final
```

Si entras por `www.ev2.systems`, entonces `ALLOWED_ORIGINS=https://ev2.systems,https://www.ev2.systems`
**y** hay que agregar `www` al `deploy/Caddyfile`, porque hoy solo certifica el
dominio sin `www`. Dímelo y te paso el cambio.

**No hace falta ninguna variable nueva** para lo de estos tres commits.

---

## 4. Levantar

```bash
docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d --build
docker compose --env-file .env -f deploy/docker-compose.prod.yml logs api | grep -i migrat
```

Tienes que ver `Applying 019_guest_passes.sql ... ok`. Las migraciones corren
solas al arrancar la API; los **seeds no**, y por eso van aparte:

```bash
docker compose --env-file .env -f deploy/docker-compose.prod.yml exec api npm run seed:menu
docker compose --env-file .env -f deploy/docker-compose.prod.yml exec api npm run seed:supplies
```

`seed:supplies` carga las tres ubicaciones, 88 insumos, 129 recetas y 60 puntos de
entrega con su QR. **Carga existencia cero a propósito**: las botellas entran por
`almacen.html`, con una entrada de mercancía o un conteo físico. Un inventario que
arranca con números inventados no sirve para nada.

---

## 5. Comprobar, de adentro hacia afuera

```bash
bash docs/api/diagnostico-vps.sh
```

Recorre los siete saltos entre el navegador y la base y se detiene a explicar **el
primero** que falla. No cambia nada. Arregla ese, y vuelve a correrlo: los de
abajo suelen caerse en cadena.

---

## 6. La cuenta para entrar

Ya existe un gerente en esa base, así que `bootstrap` se niega (y hace bien: si no,
cualquiera con la terminal se haría gerente). Se reinicia la contraseña:

```bash
# a) ver qué cuentas hay
docker compose --env-file .env -f deploy/docker-compose.prod.yml exec postgres \
  psql -U postgres ev2 -c "SELECT email, role, must_change_password FROM users WHERE role IN ('manager','admin');"

# b) generar el hash de la contraseña que quieras (mínimo 8 caracteres)
docker compose --env-file .env -f deploy/docker-compose.prod.yml exec api \
  node -e "console.log(require('bcryptjs').hashSync('PonTuPassword1!', 10))"

# c) escribirlo, con el correo del paso (a) y el hash del paso (b)
docker compose --env-file .env -f deploy/docker-compose.prod.yml exec postgres \
  psql -U postgres ev2 -c "UPDATE users SET password_hash='EL_HASH', must_change_password=true, failed_login_attempts=0, locked_until=NULL WHERE email='EL_CORREO';"

# d) borrar esa línea del historial de bash
history -d $(history 1)
```

`must_change_password=true` es deliberado: al entrar, el sistema te obliga a
cambiarla por una que solo sepas tú, así que la que acabas de teclear en la
terminal deja de servir.

---

## 7. Las dos cosas que están FUERA del servidor

Si el paso 5 dio todo OK y el navegador sigue diciendo que no hay conexión, el
problema no está en esta máquina. Solo quedan dos:

### 7.1 El cortafuegos del proveedor

**No es `ufw`.** Hostinger tiene su propio cortafuegos en el panel, por delante del
servidor. Cuando el sitio corría en nginx sin HTTPS solo hacía falta el **80**; al
pasar a Caddy todo se fue al **443**, y si ese puerto está cerrado ahí los paquetes
se descartan sin respuesta: se ve como *conexión agotada* en el celular y como
*sin conexión* en la computadora.

Compruébalo **desde tu casa**, no desde el servidor:

```bash
curl -v --connect-timeout 8 https://ev2.systems/api/health
```

- Contesta `{"status":"ok"...}` → el servidor está bien, sigue en 7.2.
- Se queda colgado sin decir nada → **abre el 443/tcp en el panel de Hostinger.**

### 7.2 La copia guardada en tu navegador

La app guarda sus páginas para poder abrir sin señal dentro del club. Si tu
computadora ya había abierto el sitio, te está enseñando **esa copia** y luego cada
llamada real falla — que es exactamente "la página del login aparece pero no
funciona".

En el navegador: `F12` → **Aplicación** → *Service workers* → **Anular registro**,
y luego *Almacenamiento* → **Borrar datos del sitio**. O ábrelo en una ventana de
incógnito, que no usa esa copia.

---

## 8. Probar que la noche completa funciona

Con la app en línea, desde el servidor:

```bash
export SEED_PASSWORD=...    # solo si esa base tiene datos de prueba
bash docs/api/smoke-test-puerta.sh https://ev2.systems
bash docs/api/smoke-test-inventario.sh https://ev2.systems
```

> **No corras estos dos sobre el club en operación.** Crean clientes,
> reservaciones y movimientos de inventario reales, y el de la puerta baja un
> momento la regla de anticipo de reservación (la restaura al terminar, pero es una
> prueba de servidor de pruebas).

Y a mano, que es la prueba que de verdad cuenta:

1. Reserva una mesa para 4 desde `index.html`. Nacen 4 pases.
2. Abre tu pase, ponle nombre a un invitado y toca **Mandar por WhatsApp**.
3. Abre ese enlace en tu celular, **sin sesión**: ahí está su QR.
4. Entra como puerta en `staff.html` → *Puerta*. El campo del código nace
   **bloqueado**: primero el documento y *Es mayor: continuar*.
5. Teclea el código del invitado. Entra **una** persona; el mismo código otra vez
   dice *ese pase ya se usó*, y los otros tres siguen sirviendo.

---

## Lo que sigue pendiente, y de quién depende

| Pendiente | De quién |
|---|---|
| Confirmar **26 tamaños de botella** (Clase Azul, Don Julio 1942, Blue Label, Dom Pérignon, los tres 30-30…). Se cargaron a 750 ml y la pantalla de almacén los marca hasta que alguien los confirme | Erick |
| **Primer conteo físico** en el almacén y las dos barras, desde `almacen.html`. Todo está en cero a propósito | Almacén |
| Revisar **tres precios** que subieron al unificar barras: `CAPITAN MORGAN - COCA COLA` 120→240, `VODKA CON AGUA MINERAL (1L)` 120→220, `BUCHANANS 18 - SPRITE` 250→260 | Erick |
| Cuentas de **Stripe y Mercado Pago**. Sin ellas ningún cobro con tarjeta funciona (`docs/PAGOS_SETUP.md`) | Erick |
| El usuario del servidor es **root**. `docs/DESPLIEGUE.md` §1 pide uno sin privilegios con permiso de Docker. No urge para probar; sí antes de abrirle al público | Jovanny |
