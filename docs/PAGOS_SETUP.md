# Cómo conectar Stripe y Mercado Pago

Esta hoja es para Erick. El código ya está preparado: **el hueco existe y está probado**;
falta pegar las llaves. Mientras estén vacías, el club cobra con **pagos manuales**
(efectivo en la puerta y transferencia con revisión del gerente, paso 3.6), que ya
funciona, y las rutas de tarjeta responden `501 no implementado` en vez de fingir.

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
   - `Public Key` → `MERCADOPAGO_PUBLIC_KEY`
   - `Access Token` → `MERCADOPAGO_ACCESS_TOKEN`. **Secreto.**
3. **`MERCADOPAGO_ENV=test` o `MERCADOPAGO_ENV=live`, y no se adivina.**

   Esto no es una comodidad: hoy el token de prueba y el de producción **empiezan igual**
   (`APP_USR-`). Una versión anterior de este documento decía que los de prueba empiezan
   con `TEST-`; era cierto hace años y ya no. Quien se fíe de eso acaba cobrándole a una
   tarjeta real creyendo que está ensayando.

   Por eso el modo se **declara** en el `.env` y el servidor lo **contrasta** con el
   `live_mode` que contesta la cuenta en cada orden: si el archivo dice prueba y la cuenta
   contesta real, se detiene con un 503 y lo dice, antes de despertar la terminal.

4. Configurar la notificación (**Webhooks**) hacia:

   ```
   https://<tu-dominio>/api/payments/mercadopago/webhook
   ```

   y guardar la **clave secreta** que da esa misma pantalla en
   `MERCADOPAGO_WEBHOOK_SECRET`. Tiene que ser esa, copiada de ahí: una generada por
   nuestra cuenta no valida nada.

   Sin la firma correcta **el cobro sigue funcionando**, y eso es a propósito: la firma se
   anota pero no decide. La verdad de si se cobró sale de consultar la orden
   (`GET /v1/orders/{id}`) con nuestro propio token, porque la validación de firma de la
   Orders API tiene un defecto abierto en los SDK del propio Mercado Pago. Lo que se pierde
   sin ella es la marca `webhook_verified`, no el cobro.

5. **La terminal Point.** Se da de alta desde la app: gerente → pestaña **Pagos** →
   *Buscar en Mercado Pago* → *Dar de alta*. El alta la pasa a modo **PDV**, que es el
   único en el que obedece al sistema: una terminal en **STANDALONE** ignora las órdenes
   sin dar ningún error visible, y es el motivo número uno de "toco cobrar y no pasa nada".
   Viene así de fábrica.

   **Para ensayar sin aparato** está la terminal virtual de Mercado Pago
   (`NEWLAND_N950__SBX0000001`). No aparece en su lista de terminales —no es un aparato—,
   así que con `MERCADOPAGO_ENV=test` el sistema la ofrece solo en *Buscar en Mercado
   Pago*, ya con nombre puesto. Se da de alta como cualquier otra.

   Con credenciales de **prueba**, la Point física del club normalmente **no aparece**: solo
   aparece si tiene la sesión iniciada con la cuenta de prueba, y aun así Mercado Pago no
   deja cobrar tarjetas reales con ella. Para ensayar, la virtual.

   El ensayo completo:

   1. En el piso o la barra, levanta un pedido y cóbralo con la terminal *Prueba*. La
      pantalla se queda en "que pase su tarjeta", como con un aparato real.
   2. En el panel del gerente, Pagos → **Cobros con terminal**: el cobro aparece con dos
      botones, *Simular: pagó* y *Simular: rechazada*. Solo existen para la terminal
      virtual y con credenciales de prueba.
   3. Al simular, la pantalla del mesero se cierra sola con el resultado y el pedido queda
      pagado (o no). Desde ahí mismo se puede probar *Devolver*.

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

Mercado Pago es el que habilita **OXXO y SPEI**, que en México es lo que más se va a usar.

7. **Para cobrar de verdad (producción)** — esto no se hace antes de la Fase 7 (CLAUDE.md,
   regla 5):

   - En *Tus integraciones → tu app → Credenciales de producción*, las dos llaves van al
     `.env` **del VPS** (nunca a un chat ni al repositorio), con `MERCADOPAGO_ENV=live`.
   - La Point Smart 2 tiene que estar vinculada a **esa misma cuenta**: en la terminal se
     inicia sesión, se escanea su QR con la app de Mercado Pago y se eligen la **sucursal**
     y la **caja** (cada caja admite una sola terminal en modo PDV). Si la cuenta todavía
     no tiene sucursal y caja, se crean ahí mismo o en el panel de Mercado Pago.
   - Después, *Buscar en Mercado Pago* la encuentra; al darla de alta se pasa a PDV y
     hay que **reiniciarla**.

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
