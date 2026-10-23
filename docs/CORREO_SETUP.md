# Correo saliente — "¿Olvidaste tu contraseña?" (D131)

Desde D131 cualquier cuenta con correo —cliente, personal, gerente, administrador, incluidas
las que solo entraban con Facebook— puede pedir un enlace para escoger una contraseña nueva
desde la pantalla de acceso. El enlace llega **por correo**, y para mandar correo el
servidor necesita un proveedor SMTP. El código ya está hecho y probado; sin estos datos el
enlace de la pantalla contesta "no está disponible en este servidor" y entrar con correo,
PIN y Facebook sigue funcionando igual.

Lo hace quien administra el VPS, una sola vez, en unos 15 minutos.

---

## 1. Escoger el proveedor

Cualquiera que hable SMTP sirve. En orden de menos a más trabajo:

| Proveedor | Cuándo conviene | Límite gratis | Nota |
| --- | --- | --- | --- |
| **Gmail / Google Workspace** | Ya hay un correo del club en Google | ~500/día (Gmail), 2,000/día (Workspace) | Hace falta **contraseña de aplicación** (la cuenta debe tener verificación en dos pasos). |
| **Brevo** (antes Sendinblue) | Sin dominio propio todavía | 300/día | Da un relevo SMTP en minutos. |
| **Resend / Mailgun / Postmark** | Con dominio propio (`ev2.mx`) | 100–3,000/día | Hay que verificar el dominio (DNS: SPF y DKIM). |
| **Amazon SES** | Ya hay cuenta AWS | 3,000/mes el primer año | Empieza en "sandbox": solo manda a correos verificados hasta pedir salida. |

Un club manda **pocos** correos de este tipo (uno por olvido), así que el plan gratis de
cualquiera alcanza de sobra. Lo que importa es que el remitente sea una dirección que el
proveedor acepte: si no, el correo cae en spam o se rechaza.

## 2. Poner los datos en el `.env`

En el VPS, en el `.env` que lee `deploy/docker-compose.prod.yml`:

```ini
# Correo saliente (D131)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=clandestinoz@gmail.com
SMTP_PASSWORD=xxxx xxxx xxxx xxxx
MAIL_FROM="EV2 Clandestinoz <clandestinoz@gmail.com>"
```

- `SMTP_PORT` 587 es STARTTLS (lo normal). Si el proveedor pide 465 (TLS directo), pon 465
  y listo: el servidor lo deduce del puerto. `SMTP_SECURE=true` fuerza TLS directo en otro
  puerto, casi nunca hace falta.
- `MAIL_FROM` es lo que ve la persona. Con Gmail tiene que ser la misma cuenta de
  `SMTP_USER`; con un dominio propio puede ser `no-reply@ev2.mx` una vez verificado.
- `PUBLIC_WEB_URL` ya debería estar (lo usa Facebook Login): es la base del enlace del
  correo, `https://<dominio>/restablecer.html#token=…`.
- Opcional: `PASSWORD_RESET_RATE_LIMIT_PER_MIN` (10 por IP por minuto si no se pone).

Luego **vuelve a crear** el contenedor de la API, no basta con reiniciarlo:

```bash
docker compose -f deploy/docker-compose.prod.yml up -d api
```

(`restart` no relee el `.env`.)

## 3. Comprobar desde el servidor

```bash
curl -s -X POST https://<dominio>/api/auth/password/forgot \
  -H 'Content-Type: application/json' \
  -d '{"nightclub_slug":"ev2","email":"tu-correo@ejemplo.com"}'
```

- `202` con `"accepted": true` → el servidor aceptó. Si ese correo tiene cuenta, en menos de
  un minuto debe llegar "Restablece tu contraseña de EV2 Clandestinoz" (revisa spam la
  primera vez).
- `501` → faltan variables; el mensaje dice cuáles. Revisa el `.env` y vuelve a hacer `up -d`.
- `202` pero no llega nada y el correo SÍ tiene cuenta → el proveedor rechazó el envío. El
  motivo exacto está en el log de la API:

```bash
docker compose -f deploy/docker-compose.prod.yml logs api --since 10m | grep "Password reset mail failed"
```

Lo típico: contraseña de aplicación mal copiada (Gmail: `535 Username and Password not
accepted`), remitente no verificado, o el proveedor en sandbox (SES).

## 4. Cómo se ve para la persona

1. En la pantalla de acceso escribe su correo y toca **«¿Olvidaste tu contraseña?»** (está
   debajo del botón *Entrar*, en la app del cliente y en todas las pantallas del personal).
2. Ve el mismo mensaje haya o no cuenta: "Si ese correo tiene cuenta en el club, te mandamos
   un enlace…". Así nadie puede usar la pantalla para averiguar qué correos están registrados.
3. Abre el correo, toca el botón, y `restablecer.html` le pide la contraseña nueva dos veces.
   El enlace vale **30 minutos y una sola vez**; pedir otro anula el anterior.
4. Al guardar, **todas sus sesiones abiertas se cierran** (si alguien más tenía la contraseña
   vieja, se queda afuera) y vuelve a entrar con la nueva.

El gerente sigue pudiendo generar una contraseña temporal desde *Empleados* (D46) para el
personal que no tenga correo a la mano.
