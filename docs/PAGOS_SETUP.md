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
   - `Access Token` → `MERCADOPAGO_ACCESS_TOKEN` (las de prueba empiezan con `TEST-`).
     **Secreto.**
3. Configurar la notificación de pagos hacia `https://<tu-dominio>/api/webhooks/mercadopago`
   y guardar la firma en `MERCADOPAGO_WEBHOOK_SECRET`.

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
