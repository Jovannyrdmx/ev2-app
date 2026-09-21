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

   Para ensayar sin aparato, Mercado Pago da una terminal virtual (`SBX0000001`), que
   aparece en *Buscar en Mercado Pago* como cualquier otra. El cobro se despierta igual
   desde la app, pero **no hay ningún botón para resolverlo**: la pantalla se queda en
   "esperando la tarjeta", que es exactamente lo que haría una terminal real a la que
   nadie le pasa una tarjeta.

   Para decidir el resultado hay una ruta, que solo puede llamar un gerente:

   ```bash
   curl -X POST https://<tu-dominio>/api/nightclubs/<club>/terminal-charges/<cobro>/simulate \
     -H "Authorization: Bearer <token del gerente>" \
     -H "Content-Type: application/json" \
     -d '{"status":"processed"}'
   ```

   `status` acepta `processed`, `failed`, `canceled`, `expired` y `action_required`. Al
   mandarlo, Mercado Pago avisa por el webhook y el cobro se cierra solo en la pantalla,
   sin recargar. Ese es el ensayo completo de punta a punta.

Mercado Pago es el que habilita **OXXO y SPEI**, que en México es lo que más se va a usar.

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
