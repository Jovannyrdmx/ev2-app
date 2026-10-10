# Cómo conectar Stripe y Mercado Pago

Esta hoja distingue configuración, pruebas y operación real. Mercado Pago Point cuenta
con envío de órdenes, consulta del resultado, webhook firmado y notificaciones internas.
Eso no certifica una terminal física ni significa que las credenciales de un VPS ya
estén verificadas. Los pagos manuales existentes se conservan.

## Revisión Point del 1 de octubre de 2026

Rama: `fase7/mercadopago-notificaciones`. Código `109f308` publicado en el VPS el
1 de octubre por la noche, conservando `MERCADOPAGO_ENV=test`. No activar cobros reales
hasta completar la configuración y aceptación de la terminal física.

- Un cobro aprobado se registra junto con sus avisos en una sola transacción SQL.
- Un rechazo muestra el motivo de la tarjeta cuando está disponible.
- Un timeout, error 5xx o respuesta ambigua deja el intento pendiente; no libera la cuenta
  para volver a cobrar. Repetir la petición de la misma cuenta y terminal recupera ese intento.
- La recuperación reutiliza la solicitud original y su llave, guardadas antes del envío.
  El sistema no reconstruye solicitudes antiguas ni reenvía creaciones después de su límite
  conservador de 23 horas; esos casos requieren conciliación con el proveedor.
- Sin ID de Mercado Pago no se confirma una cancelación local. Tampoco se permite
  liquidar manualmente una cuenta mientras exista un intento pendiente.
- Un resultado aprobado con importe faltante, referencia incorrecta, moneda diferente o
  varios pagos inesperados no liquida la cuenta. Queda bloqueado para revisión.
- La pantalla distingue **Pago aprobado**, **Pago rechazado**, **Pago pendiente de
  confirmación** y **Pago pendiente de revisión**. El reloj del navegador no declara
  que una transacción venció.

Pruebas aisladas: 185 pruebas en cinco suites de pagos/eventos/componente, 1,250 pruebas
web en 38 suites y 135 pruebas adicionales de pedidos, propinas, cortes y recibos.
Estos conjuntos se superponen; no deben sumarse como pruebas distintas.
Compilación web correcta; ESLint sin errores y con seis advertencias en archivos no
modificados. No se realizaron cargos reales ni se certificó hardware físico.

La credencial guardada en el formulario seguro no pudo verificarse desde el entorno
de trabajo: devolvió HTTP 502 sin respuesta JSON. No se copió al VPS ni al código.
Una consulta independiente desde el VPS, usando sus variables ya existentes, sí
devolvió HTTP 200: cuenta de prueba (`test_user`), país `MX`, sitio `MLM`, sin terminales
físicas asociadas. Esto valida la configuración preexistente del servidor, no demuestra
que corresponda a la credencial recién compartida ni verifica la entrega del webhook.
En EV2 solo estaba registrada la terminal virtual **Prueba**; no había cobros Point
ni devoluciones pendientes y las 37 migraciones existentes ya estaban aplicadas.

Después del despliegue: página principal, `/api/health`, `sw.js` y el componente de
terminal respondieron HTTP 200. La PWA sirve `ev2-v35`. Una solicitud de diagnóstico
sin firma recibió 401; una firmada con el secreto del servidor y un ID inexistente
recibió 200/ignorada, sin crear cobros. Esto prueba la ruta y el validador del servidor,
no una entrega iniciada por Mercado Pago ni un pago real.

Solo se recrearon API (`dd0e6b12135a`) y web (`d440184ccb59`), ambas saludables.
PostgreSQL, Redis, WebSocket y Caddy conservaron sus contenedores. Respaldo:
`/root/respaldos/mercadopago-20261002-064414/`; imágenes de reversión:
`ev2-api:before-point-109f308` y `ev2-web:before-point-109f308`.
El primer intento se revirtió por permisos de lectura de los archivos; se corrigió
la máscara de creación y se verificó la lectura de las imágenes antes del segundo
intento, que pasó. No hubo migraciones nuevas ni cargos.

## Dónde van las llaves

En el archivo **`.env`** de la raíz del proyecto — **nunca en la base de datos y nunca en
git**. Una llave secreta guardada en Postgres es una llave secreta en cada respaldo, en
cada réplica y en cada volcado que alguien pida para restaurar.

`.env.example` ya trae los campos vacíos con el formato de cada uno. Copia esas líneas a
tu `.env` y pega los valores.

## Stripe

1. Crear la cuenta en **dashboard.stripe.com** con los datos fiscales del negocio.
2. Dejar el interruptor en **Test mode** (arriba a la derecha).
3. **Developers → API keys**. Copiar:
   - `Publishable key` → `STRIPE_PUBLISHABLE_KEY` (empieza con `pk_test_`). Es pública: la
     usa el navegador del cliente.
   - `Secret key` → `STRIPE_SECRET_KEY` (empieza con `sk_test_`). **Secreta.** No se manda
     al navegador ni se pega en un chat.
4. **Developers → Webhooks → Add endpoint**, apuntando a
   `https://<tu-dominio>/api/webhooks/stripe`. Copiar el `Signing secret` →
   `STRIPE_WEBHOOK_SECRET` (empieza con `whsec_`). Sin él los webhooks se rechazan, que es
   lo correcto: sin firma, cualquiera podría avisar que un pago se completó.

> El endpoint del webhook necesita un dominio público con HTTPS, así que este paso se
> completa en la Fase 7. Para desarrollo, el CLI de Stripe (`stripe listen`) entrega un
> `whsec_` local.

## Mercado Pago

1. Crear la cuenta en **mercadopago.com.mx** con los datos fiscales.
2. **Tus integraciones → crear aplicación → Credenciales de prueba**. Copiar:
   - `Public Key` → `MERCADOPAGO_PUBLIC_KEY` (opcional para este flujo Point)
   - `Access Token` → `MERCADOPAGO_ACCESS_TOKEN`. **Secreto.**
3. **`MERCADOPAGO_ENV=test` o `MERCADOPAGO_ENV=live`, y no se adivina.**

   Esto no es una comodidad: hoy el token de prueba y el de producción **empiezan igual**
   (`APP_USR-`). Una versión anterior de este documento decía que los de prueba empiezan
   con `TEST-`; era cierto hace años y ya no. Quien se fíe de eso acaba cobrándole a una
   tarjeta real creyendo que está ensayando.

   El modo se declara y se contrasta con `live_mode` cuando el proveedor lo devuelve.
   Esa validación ocurre después de la llamada, por lo que una discrepancia mantiene
   el cobro pendiente de revisión y no se presenta como prueba de que no hubo cargo.
   Como protección adicional, este sistema solo permite la terminal virtual en modo
   `test`, y solo terminales físicas en modo `live`.

4. Configurar la notificación (**Webhooks**) hacia:

   ```
   https://ev2.systems/api/payments/mercadopago/webhook
   ```

   y guardar la **clave secreta** que da esa misma pantalla en
   `MERCADOPAGO_WEBHOOK_SECRET`. Tiene que ser esa, copiada de ahí: una generada por
   nuestra cuenta no valida nada.

   Seleccionar el evento **Order (Mercado Pago)** en Webhooks. Para una cuenta de
   prueba, la configuración de notificaciones se realiza entrando con esa cuenta
   y usando su sección de producción, según la [guía oficial de Point](https://www.mercadopago.com.mx/developers/en/docs/mp-point/notifications).

   **La firma ahora es obligatoria.** El servidor devuelve 401 ante una firma inválida,
   y no inicia cobros nuevos si falta `MERCADOPAGO_WEBHOOK_SECRET`. La firma usa el
   `data.id` de la URL en minúsculas y omite los campos ausentes; después se consulta
   `GET /v1/orders/{id}` para decidir el resultado, conforme a la
   [documentación de notificaciones](https://www.mercadopago.com.mx/developers/en/docs/mp-point/notifications).
   Un fallo de consulta devuelve 503 para permitir reintentos, en lugar de confirmar
   falsamente que el aviso ya fue procesado. Los avisos repetidos no liquidan dos veces.

5. **La terminal Point.** Se da de alta desde la app: gerente → pestaña **Pagos** →
   *Buscar en Mercado Pago* → *Dar de alta*. El alta la pasa a modo **PDV**, que es el
   único en el que obedece al sistema: una terminal en **STANDALONE** ignora las órdenes
   sin dar ningún error visible, y es el motivo número uno de "toco cobrar y no pasa nada".
   Viene así de fábrica.

   **Para ensayar sin aparato** está la terminal virtual de Mercado Pago
   (`NEWLAND_N950__SBX0000001`). No aparece en su lista de terminales —no es un aparato—,
   así que con `MERCADOPAGO_ENV=test` el sistema la ofrece solo en *Buscar en Mercado
   Pago*, ya con nombre puesto. Se da de alta como cualquier otra.

   Para ensayar este sistema se usa exclusivamente la terminal virtual. La prueba con
   una terminal física requiere confirmar el modelo, la cuenta vinculada y el alcance
   de la prueba por separado; no se autoriza implícitamente al configurar credenciales.

   El ensayo completo:

   1. En el piso o la barra, levanta un pedido y cóbralo con la terminal *Prueba*. La
      pantalla se queda en "que pase su tarjeta", como con un aparato real.
   2. En el panel del gerente, Pagos → **Cobros con terminal**: el cobro aparece con dos
      botones, *Simular: pagó* y *Simular: rechazada*. Solo existen para la terminal
      virtual y con credenciales de prueba.
   3. La pantalla del mesero muestra el resultado confirmado. Solo si el proveedor reporta
      aprobación válida queda pagado el pedido. El empleado cierra el aviso con **Listo**
      o **Volver**; no se presupone que el resultado haya sido visto.

   Lo mismo por API, si se prefiere:

   ```bash
   curl -X POST https://<tu-dominio>/api/nightclubs/<club>/terminal-charges/<cobro>/simulate \
     -H "Authorization: Bearer <token del gerente>" \
     -H "Content-Type: application/json" \
     -d '{"status":"processed"}'
   ```

6. **Cancelar y devolver.**

   - *Cancelar* sirve mientras la tarjeta no pase, **aunque la terminal ya enseñe el
     monto**. Si Mercado Pago aun así se niega, la pantalla lo dice y hay que
     cancelarlo en la propia terminal; el sistema se entera solo.
   - *Devolver* es del gerente: Pagos → **Cobros con terminal** → *Devolver*. Pide el
     motivo (se guarda con su nombre) y confirma con el monto y la tarjeta. Devuelve el
     cobro **completo**, dentro de los 90 días que da Mercado Pago. En el libro, el
     cobro sale del ingreso y la devolución queda como salida en su propio renglón.
   - Una devolución hecha desde el **panel de Mercado Pago** también llega al libro, por
     el webhook, marcada como externa.
   - Si la terminal cobró **propina**, se ve en el cobro y en su lista, pero no entra al
     ingreso del club.

Este bloque implementa **tarjeta en terminal Point**. No habilita OXXO, SPEI ni cobro
de tarjeta dentro de la app del cliente.

7. **Para cobrar de verdad (producción)** — esto no se hace antes de la Fase 7 (CLAUDE.md,
   regla 5):

   - El Access Token y el secreto del webhook se configuran en el `.env` del VPS, nunca
     en chat ni en Git. La Public Key es opcional para Point. Declarar
     `MERCADOPAGO_ENV=live` únicamente después de verificar la cuenta.
   - La Point Smart 2 tiene que estar vinculada a **esa misma cuenta**: en la terminal se
     inicia sesión, se escanea su QR con la app de Mercado Pago y se eligen la **sucursal**
     y la **caja** (cada caja admite una sola terminal en modo PDV). Si la cuenta todavía
     no tiene sucursal y caja, se crean ahí mismo o en el panel de Mercado Pago.
   - Después, *Buscar en Mercado Pago* la encuentra; al darla de alta se pasa a PDV y
     hay que **reiniciarla**.

## Lista de aceptación antes de habilitar la terminal real

- Confirmar modelo compatible y cuenta mexicana; no deducirlo del prefijo del token.
- Renovar cualquier token o contraseña compartidos por chat y usar almacenamiento seguro.
- Consultar cuenta y terminales sin cargos. Verificar la asociación del dispositivo y el
  modo PDV, como describe el [flujo oficial de procesamiento](https://www.mercadopago.com.mx/developers/es/docs/mp-point/payment-processing).
- Configurar el webhook HTTPS y su secreto en la misma cuenta/aplicación.
- Revisar intentos pendientes antes de actualizar. Los intentos antiguos sin solicitud
  original guardada no se reenvían automáticamente.
- Respaldar imágenes, código y configuración del VPS sin copiar secretos al repositorio.
  Verificar migraciones pendientes antes de reiniciar: el Compose ejecuta migraciones al
  iniciar la API, aunque este cambio no agrega ninguna.
- Publicar únicamente con autorización. Probar primero con la cuenta virtual aislada;
  no simular pedidos dentro de la caja activa.
- Acordar por separado una prueba física con importe explícito. Verificar importe,
  aprobación/rechazo, folio, actualización del sistema, corte y devolución si procede.
- Retirar la llave SSH temporal al terminar y conservar un procedimiento de reversión.

## Cómo saber si quedó

Al arrancar, la API lo dice en la primera línea:

```
Payments: stripe NOT configured — falta STRIPE_SECRET_KEY, ... (docs/PAGOS_SETUP.md)
Payments: stripe configured (test mode)
```

Y el gerente lo ve desde la app en `GET /api/nightclubs/{id}/payment-providers`, con la
lista exacta de lo que falta.

## Dos protecciones que ya están puestas

- **La API se niega a arrancar con llaves de producción si `NODE_ENV` no es `production`.**
  Es el error que cobra una tarjeta real durante una demostración; mejor que el servidor
  no encienda a que cobre.
- Las llaves **secretas nunca salen** por la API. `payment-providers` devuelve solo la
  llave pública, que de todos modos viaja al navegador.

## Cuándo se usan de verdad

| Paso | Qué necesita |
|---|---|
| 3.4 Stripe (PaymentIntents, Apple Pay, Google Pay) | Llaves de **prueba** de Stripe |
| 3.5 Mercado Pago (tarjeta, OXXO, SPEI) | Credenciales de **prueba** de Mercado Pago |
| 7.12 Corte a producción | Llaves **live** de ambos, y solo con `NODE_ENV=production` |

Las de producción no se tocan hasta la Fase 7, y el primer cobro real se hace por un monto
pequeño, como dice el manual.
