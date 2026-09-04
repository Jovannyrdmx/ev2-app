# Referencia oficial del negocio

Documentos entregados por el dueño el 3 de septiembre de 2026. **Son la fuente de verdad**
para el plano del local y las tarifas; el código y los seeds se derivan de ellos.

| Archivo | Qué es |
|---|---|
| `mapa-ev2-oficial.jpg` | "PICK YOUR PARTY": plano vigente de las dos plantas con las 55 mesas, sus números y zonas. |
| `precios-ev2-oficial.jpg` | "VIP PRECIOS": tarifas por zona vigentes desde enero de 2026, en pesos mexicanos. |

Se transcriben en:

- `server/seeds/data/ev2-floor-plan.json` — plano (mesas, zonas, pisos, coordenadas y áreas).
- `server/seeds/data/ev2-price-list.json` — tarifas por zona, botellas y extras.

Reglas del negocio derivadas de estos documentos y de lo que confirmó el dueño (ver D17 en
`docs/DECISIONES.md`):

1. La mesa se vende **por toda la noche**, no por horas.
2. El precio de la zona cubre un número de boletos; las personas adicionales pagan **el boleto
   de esa noche**, y cada zona tiene un tope de extras (Zona Roja no admite ninguno).
3. El **precio del boleto cambia según el evento**, y el gerente puede ajustar precio, boletos
   incluidos o extras de cualquier zona **solo para un evento**.
4. Plazo de llegada: **3 horas** desde la apertura. Después la mesa se libera y **no hay reembolso**.

Cuando el club cambie el plano o los precios, se actualizan estas imágenes y los dos archivos
JSON en el mismo commit, y se ejecuta `npm run seed:floor` / `npm run seed:prices`.
