# Entrar con Facebook — alta de la app de Meta

Esta es la única parte del acceso con Facebook que **no** se puede programar: hay que dar de
alta una app en el panel de Meta con la cuenta del dueño del club, y pegar dos valores en el
`.env` del servidor. El código ya está hecho y probado; sin estos dos valores, el botón
simplemente no se pinta y el correo y la contraseña siguen funcionando igual.

Lo hace **Erick** (es su negocio el que queda dado de alta ante Meta), una sola vez, en unos
20 minutos. Si algo no cuadra, el paso 6 dice cómo comprobarlo desde el servidor.

---

## Antes de empezar: Instagram no se puede, y no es una falta de configuración

**"Iniciar sesión con Instagram" ya no existe para cuentas personales.** La Instagram Basic
Display API se apagó el **4 de diciembre de 2024**, y sus dos sucesores (Instagram API with
Instagram Login e Instagram Graph API) solo funcionan con cuentas **Business o Creator**, y
ninguno de los dos entrega el correo.

O sea: un cliente del club, con su Instagram normal, no puede entrar con Instagram. No hay
credenciales que poner ni pantalla que arreglar. El proveedor queda **declarado y apagado** en
`server/src/config/oauth.js`, con ese motivo escrito, por dos razones: para que nadie vuelva a
pedirlo sin enterarse de por qué no está, y para que el día que Meta reabra el login de
consumidor se encienda poniendo credenciales, sin tocar código.

La misma estructura acepta **Google** y **Apple**, que sí hacen login de consumidor con correo
verificado. Si algún día hay app de iOS, Apple además es obligatorio en la App Store para
cualquier app que ofrezca login social.

---

## 1. Crear la app

1. Entra a **developers.facebook.com** con la cuenta de Facebook del negocio (no una personal
   de un empleado: si esa persona se va, la app se va con ella).
2. **Mis apps → Crear app.**
3. Caso de uso: **"Autenticación y solicitud de datos de cuenta"**.
   Es el que trae Facebook Login y nada más. No hace falta ninguno de los otros.
4. Nombre de la app: lo que quieras que vea el cliente en la pantalla de permisos —
   `EV2 Clandestinoz` es lo razonable, porque es lo que va a leer antes de autorizar.
5. Correo de contacto: uno que de verdad se lea. Meta avisa ahí de cambios que rompen el login.

## 2. Copiar las dos credenciales

**Configuración de la app → Basico**:

| En el panel de Meta | En el `.env` del servidor |
|---|---|
| Identificador de la app | `FACEBOOK_APP_ID` |
| Clave secreta de la app (hay que darle a "Mostrar") | `FACEBOOK_APP_SECRET` |

La clave secreta es **secreta**: no va al navegador, no va al repositorio, y no se manda por
WhatsApp ni por correo. Va directo al `.env` del servidor y a ningún otro lugar. Si se filtra,
se regenera en ese mismo panel y se cambia en el `.env`.

## 3. Dar de alta la dirección de retorno

Este es el paso donde falla todo el mundo la primera vez. Meta compara la dirección de retorno
**carácter por carácter**: una barra de más, `http` en vez de `https`, o `www.` de sobra, y
rechaza el viaje con un error que habla de la URI y no de la causa.

La dirección exacta la dice el propio servidor. En el VPS:

```bash
cd ~/ev2-app/deploy
docker compose -f docker-compose.prod.yml exec api \
  node -e "console.log(require('./src/config/oauth').status().providers[0].redirect_uri)"
```

Sale algo así:

```
https://ev2.systems/api/auth/oauth/facebook/callback
```

Eso se pega, **tal cual**, en **Facebook Login → Configuración → URI de redireccionamiento de
OAuth validos**. Y en la misma pantalla:

- **Iniciar sesión con el SDK de JavaScript**: apagado. Este sistema no usa el SDK del
  navegador; el viaje lo arma el servidor.
- **Iniciar sesión con OAuth**: encendido.
- **Iniciar sesión con OAuth del cliente**: encendido.
- **Aplicar HTTPS**: encendido.

## 4. Permisos: solo dos, y son los que no necesitan revisión

En **Casos de uso → Autenticación → Permisos**, deja únicamente:

- `public_profile` — el nombre. Viene por omisión.
- `email` — el correo.

No pidas amigos, fotos ni publicaciones. No hacen falta para dejar entrar a alguien, alargan la
pantalla de permisos, bajan la cantidad de gente que la termina, y obligan a una **revisión de
app** por parte de Meta que el club no tiene por qué pasar. Con estos dos no hay revisión.

## 5. Ponerlo en el `.env` y reiniciar

En el VPS, en `~/ev2-app/deploy/.env`:

```
FACEBOOK_APP_ID=1234567890123456
FACEBOOK_APP_SECRET=la-clave-secreta-del-panel
```

Y se reinicia solo la API:

```bash
cd ~/ev2-app/deploy
docker compose -f docker-compose.prod.yml up -d api
```

## 6. Comprobar que quedó

```bash
curl -s https://ev2.systems/api/auth/oauth/providers | python3 -m json.tool
```

Lo que tiene que decir:

```json
{
  "providers": [
    { "provider": "facebook",  "label": "Facebook",  "enabled": true,  "available": true },
    { "provider": "instagram", "label": "Instagram", "enabled": false, "available": false,
      "unavailable_reason": "instagram_consumer_login_discontinued" }
  ],
  "any_enabled": true,
  "password_available": true
}
```

`"enabled": true` en Facebook es lo único que hace que el botón aparezca en la pantalla de
acceso. Si sale `false`, la vista del gerente dice qué falta:

```bash
docker compose -f docker-compose.prod.yml exec api \
  node -e "console.log(JSON.stringify(require('./src/config/oauth').status(), null, 2))"
```

El campo `missing` nombra la variable que falta. **Nunca sale la clave secreta**, solo su
nombre.

Después, la prueba de verdad: abrir `https://ev2.systems` en el teléfono, darle al botón de
Facebook, autorizar, y ver que entra. La primera vez pedirá **fecha de nacimiento y aceptar los
términos** antes de crear la cuenta — eso es a propósito (abajo se explica).

## 7. Antes de que entre gente que no seas tú

Mientras la app está en modo **desarrollo**, solo pueden entrar las cuentas de Facebook que
estén dadas de alta como administrador, desarrollador o probador de la app. Para el público hay
que pasarla a **modo activo** (el interruptor arriba en el panel), y para eso Meta pide:

- **Política de privacidad** con URL pública. Es un requisito de Meta, no del sistema.
- **URL de eliminación de datos** o instrucciones de cómo se borra una cuenta.
- El **ícono** de la app (1024×1024) y la categoría del negocio.

Con `public_profile` y `email` no hace falta revisión de app, pero estos datos sí.

---

## Lo que va a pasar y no es un error

**"Me pidió la fecha de nacimiento aunque entré con Facebook."**
A propósito. El club es solo para mayores de 18 y de ese dato depende dejar entrar a alguien a
un negocio de alcohol. Facebook **no** entrega una fecha de nacimiento fiable, así que
inventarla sería inventar la edad de un cliente. Se pide una vez, al crear la cuenta.

**"Mi correo ya tenía cuenta en el club y no me dejó entrar con Facebook."**
También a propósito, y es la protección más importante de todo esto. Si una cuenta social se
ligara sola a una cuenta que ya existe porque el correo coincide, cualquiera que logre que un
proveedor le acepte un correo ajeno se quedaría con la cuenta de ese cliente, con sus
reservaciones y su historial. El camino es: entrar con la contraseña, y ligar Facebook desde
**Perfil → Cuentas ligadas**. Auth0 y Okta traen esto apagado por omisión por la misma razón.

**"No me deja quitar Facebook de mi perfil."**
Si es la única manera de entrar que tiene esa cuenta (sin contraseña y sin otra cuenta ligada),
quitarlo dejaría a la persona fuera de su propia cuenta, con sus reservaciones adentro, y la
única salida sería que el gerente le reinicie la contraseña a mano en la base de datos. Primero
se le pone una contraseña, después se quita.

**"El cliente no dio permiso del correo."**
Se le pide en la pantalla de completar el registro. La cuenta se crea igual.

---

## Lo que el sistema NO guarda

- **El token de acceso de Facebook.** Se usa una vez para leer el nombre y el correo, y se
  descarta. No hay columna en la base donde guardarlo. Guardarlo sería guardar una llave del
  Facebook del cliente para siempre, cuando el sistema no necesita volver a entrar ahí nunca —
  y una fuga de esta base pasaría de ser un problema del club a ser un problema dentro de la
  cuenta personal de cada cliente.
- **Nada más del perfil.** Solo el id que Facebook le da a esa persona, su nombre y su correo.
- **La clave secreta de la app, en la base de datos.** Vive solo en el `.env`, porque un
  secreto en Postgres es un secreto en cada respaldo.

## Detalle técnico, para quien vuelva a este archivo en un año

- La versión de la API de Meta está **fijada** en `v21.0` (`server/src/config/oauth.js`). Meta
  retira versiones cada dos años; una llamada sin versión se mueve sola bajo los pies el día
  que retiran la actual. Cuando toque subirla, es una línea y las pruebas de `oauth.test.js`
  dicen si algo cambió de forma.
- El `state` de OAuth vive en la tabla `oauth_states` y es de **un solo uso**: se consume con
  `DELETE ... RETURNING`. Un state firmado en cookie se puede reproducir tantas veces como
  quepa en su vigencia.
- La sesión **no** viaja en la dirección de retorno. Lo que vuelve en `#h=` es un pase de un
  solo uso que vive 2 minutos y se canjea con `POST /api/auth/oauth/handoff`. El fragmento de
  una dirección no viaja al servidor, pero sí se queda en el historial del navegador, y en un
  teléfono prestado o compartido eso sería la sesión del cliente al alcance del siguiente.
- La dirección de retorno se arma con `PUBLIC_WEB_URL` (o el primer `ALLOWED_ORIGINS`), nunca
  con la cabecera `Host` de quien pide: un enlace armado con lo que manda el cliente es un
  enlace a donde ese cliente quiera, saliendo con la cara del club.
- Las decisiones completas, con las alternativas descartadas, están en `docs/DECISIONES.md`,
  fila **D41**. La API, en `server/openapi.yaml` bajo la etiqueta *Autenticación*.
