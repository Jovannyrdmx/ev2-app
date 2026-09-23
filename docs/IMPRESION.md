# Imprimir en papel — EV2 Clandestinoz

Cómo salen del sistema la comanda de la barra, la cuenta de la mesa, el recibo de
cobro y el corte de turno. Decisión **D52**.

## El problema, primero

El servidor de EV2 corre en un VPS. Las impresoras están en la red local del club,
detrás del módem. **El servidor no puede alcanzarlas**, y el navegador tampoco: una
página web no abre conexiones TCP crudas.

Abrir el puerto 9100 de una impresora a internet resolvería lo primero y crearía algo
peor: cualquiera en el mundo podría imprimir lo que quisiera en la barra.

## Cómo se resuelve

Tres piezas:

```
  VPS                              red del club
┌──────────────────┐            ┌──────────────────────────────┐
│  API de EV2      │            │  PC de barra                 │
│                  │            │  ┌────────────────┐          │
│  arma el ticket  │  ← pide ───┼──│ print-agent.js │          │
│  y lo deja en    │  trabajo   │  └───────┬────────┘          │
│  la cola         │  ── da ────┼─────────>│  bytes ESC/POS    │
│                  │    bytes   │          ▼                   │
└──────────────────┘            │   192.168.1.50:9100          │
                                │   (impresora térmica)        │
                                └──────────────────────────────┘
```

1. **El servidor** decide qué se imprime y a qué impresora va, arma los bytes
   ESC/POS y los deja escritos en `print_jobs`. Nunca se conecta a una impresora.
2. **El agente** (`agent/print-agent.js`) corre en una PC del club, se conecta
   **hacia afuera** al servidor, toma trabajos y se los pasa a la impresora por la
   red local. No abre ningún puerto; no hay que tocar el módem del club.
3. **La impresora** recibe los bytes por el puerto 9100, o por el spooler de Windows
   si está conectada por USB.

## El enrutado: quién imprime qué, sin configurarlo dos veces

Una impresora cuelga de una **barra** (`supply_locations` con `kind='bar'`) y tiene
un **propósito**:

| Propósito | Qué imprime | Dónde está |
|---|---|---|
| `orders` | Comandas | PC del bartender |
| `service` | Cuentas y recibos de cobro | PC de meseros |

Un papel dice de qué zona viene. `zone_bars` dice qué barra atiende esa zona —y el
gerente la reasigna a media noche sin tocar nada de impresión—, y el propósito escoge
cuál de las dos PCs de esa barra.

Una barra no puede tener dos impresoras activas del mismo propósito. Si pudiera, "la
impresora de comandas de la barra baja" dejaría de ser una respuesta.

> Si una zona no tiene barra asignada, **no se adivina un destino**. Devolver
> "cualquiera" haría que las comandas del VIP salieran en otra barra sin que nadie
> entienda por qué.

## Qué pasa cuando falla

Falla seguido: sin papel, atascada, apagada, cable flojo. Por eso hay cola y no
llamada directa — con una llamada directa el **trago** fallaría junto con la
impresora.

| Intento | Qué hace el servidor |
|---|---|
| 1 | Devuelve el trabajo a la cola con el motivo |
| 2 | **Desvía** el papel a la otra impresora de esa barra |
| 3 (`max_attempts`) | Se rinde: queda `failed`, en rojo en el panel del gerente |

Un desvío es un trabajo **nuevo** con `rerouted_from` apuntando a la que falló: un
trabajo ya escrito no cambia de impresora, porque entonces nadie podría reconstruir
después dónde se suponía que iba a salir ese ticket. Y un papel ya desviado no se
vuelve a desviar: con dos impresoras por barra rebotaría entre las dos mientras el
cliente espera su cuenta.

Dos casos más que importan:

- **Dos PCs preguntando a la vez.** El servidor entrega cada trabajo a una sola
  (`FOR UPDATE SKIP LOCKED`). Es lo único que impide que el cliente reciba dos
  cuentas idénticas.
- **Apagan una PC a medio trabajo.** El trabajo vuelve solo a la cola a los dos
  minutos y lo toma la otra.

Nada de esto se pierde en silencio: lo que no salió se ve en **Impresoras → Últimos
tickets**, con el motivo completo, y desde ahí se reimprime.

## Los acentos

Las impresoras térmicas no saben UTF-8. Usan **páginas de códigos**: una tabla de 256
caracteres que se escoge con un comando. Las Xprinter salen de fábrica en **CP437**,
que **no tiene ñ** ni vocales acentuadas — y "Coñac añejo" es de lo primero que se lee
en el ticket de un bar mexicano.

El servidor codifica el texto a la página de códigos de **esa** impresora, y lo que la
tabla no tiene se pliega a la letra sin acento (`Á` → `A` en CP437). Feo es mejor que
ilegible: un byte fuera de tabla deja a la impresora escribiendo basura el resto del
papel.

| Página | Cuándo |
|---|---|
| `CP850` | Por omisión. Tiene minúsculas y mayúsculas acentuadas, ñ, ¿ y ¡ |
| `CP1252` | Si la impresora la soporta; es idéntica a lo que usa Windows |
| `CP858` | Como CP850, con el símbolo del euro |
| `CP860` | Portugués |
| `CP437` | La de fábrica. Sin mayúsculas acentuadas |

**No hay forma de saber cuál es la correcta sin imprimir.** Por eso el ticket de
prueba trae acentos, ñ, una regla de ancho completo y el corte: son exactamente las
tres cosas que salen mal. Si el papel sale bien, esa impresora ya sirve.

## Poner el club a imprimir

### 1. Dar de alta las impresoras

Panel del gerente → pestaña **Impresoras** → *Dar de alta una impresora*. Por cada
una: la barra, el propósito, la IP, el ancho del papel.

### 2. Encender el respaldo

Edita cada impresora y ponle como respaldo (`fallback_id`) la otra de su misma barra.
Sin esto, una impresora atascada detiene su papel hasta que alguien la atienda.

### 3. Dar de alta las PCs

**Impresoras → PCs que imprimen → Nueva PC.** Dos, una por barra: como las impresoras
están en la red, cualquier agente las alcanza todas, y con dos, si apagan una PC la
otra sigue sacando todo el papel del club.

El panel enseña un **token que se ve una sola vez**. La base guarda solo su huella
(SHA-256), así que no se puede recuperar: quien lo pierda da de alta otra PC y apaga
la anterior.

### 4. Instalar el agente

Sigue `agent/README.md`. Resumido: Node.js 18+, copiar la carpeta, poner el token en
`config.json`, y dejarlo arrancando con Windows.

### 5. Probar

Botón **Probar** en cada impresora. Si los acentos salen rotos, cambia la página de
códigos y vuelve a probar. **No avances hasta que las cuatro saquen su papel bien.**

### 6. Prender la comanda por pedido

**Impresoras → Ajustes → "Imprimir comanda en la barra con cada pedido"**. Solo el
administrador puede cambiarlo, y arranca apagado a propósito: un club sin impresoras
configuradas no debe empezar a encolar papel que nadie va a recoger.

El recibo de cobro sale siempre: es el respaldo de que ese dinero entró, y es lo que
hace que el corte del turno cuadre sin discutir.

## Seguridad

- El agente **no recibe conexiones**. Se conecta hacia afuera; el club no abre ningún
  puerto.
- Su token no es una sesión de persona: no tiene rol, no pertenece a nadie, y lo único
  que puede hacer es tomar trabajos de su club e informar cómo le fue. Un usuario
  "impresora" con contraseña eterna en un archivo de la barra podría hacer todo lo que
  hace un empleado.
- El token se guarda hasheado. Un token robado se apaga desde el panel, sin tocar la
  PC.
- Los trabajos impresos son inmutables y no se borran: ese ticket está en la mano de
  alguien, y cambiar aquí lo que dice sería inventar una historia distinta de la que
  anda circulando por el club.

## Una limitación honesta

Un puerto 9100 acepta los bytes aunque la impresora esté sin papel. Por eso el agente
le **pregunta** antes de imprimir (`DLE EOT 4`, la consulta de estado en tiempo real)
y reporta "se quedó sin papel" como lo que es. Las impresoras que no implementan esa
consulta no contestan, y entonces se dan por buenas y se sigue: no saber no es lo
mismo que estar sin papel.

Con `checkPaper: false` en el agente, "impreso" vuelve a significar solo "la impresora
aceptó los bytes".

## Impresoras del club

| Modelo | Papel | Conexión | Columnas |
|---|---|---|---|
| Xprinter XP-C260M | 80 mm | USB + LAN (según versión, WiFi/Bluetooth) | 48 |
| Xprinter XP-A160H | 80 mm | USB / LAN según versión | 48 |

Las dos cortan el papel solas y hablan ESC/POS. La A160H se vende también en versión
**solo USB**: esa se da de alta con conexión *Windows* y su nombre compartido, y la
imprime el agente que corre **en esa misma PC**.

## Referencias

- Rutas y esquemas: `server/openapi.yaml`, etiqueta **Impresión**.
- Migración: `server/migrations/031_printing.sql`.
- Generador de bytes: `server/src/services/escpos.js`.
- Cola y enrutado: `server/src/services/printing.js`.
- El agente: `agent/README.md`.
