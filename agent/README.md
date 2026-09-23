# Agente de impresión EV2

Este programa es el puente entre el servidor de EV2 y las impresoras térmicas del
club. Corre en una PC de barra y no necesita que nadie abra un puerto del club a
internet: se conecta **hacia afuera**, pregunta si hay papel pendiente y lo imprime.

## Por qué hace falta

El servidor está en un VPS, fuera del club. Las impresoras están en la red local de
la barra. El servidor no puede alcanzarlas, y publicar el puerto 9100 de una
impresora en internet dejaría que cualquiera imprima lo que quiera en la barra. El
agente resuelve eso sin exponer nada.

## Cuántos hacen falta

**Dos**, uno por barra. No uno por impresora: como las impresoras están en la red
con su IP, cualquier agente las alcanza todas. Con dos, si apagan una PC la otra
sigue sacando todo el papel del club.

Los dos toman de la misma cola sin pisarse: el servidor entrega cada trabajo a uno
solo, así que **nunca sale el mismo ticket dos veces**.

## Instalación

### 1. Node.js

Instala Node.js 18 o más nuevo desde <https://nodejs.org> (la opción "LTS"). El
agente no usa ninguna librería externa: con Node basta.

### 2. Copiar la carpeta

Copia esta carpeta `agent/` a la PC, por ejemplo en `C:\EV2\agent`.

### 3. Crear el agente en el panel

En el panel del gerente → **Pagos → Impresoras → Agentes → Nuevo agente**. Ponle el
nombre de la PC ("PC barra baja"). El panel te enseña un **token** que empieza con
`ev2ag_`.

> Ese token se enseña **una sola vez**. Si se pierde, no se puede recuperar: se crea
> otro agente y se apaga el anterior. Es a propósito: la base guarda solo su huella.

### 4. config.json

Copia `config.example.json` a `config.json` y pon tu dominio y tu token:

```json
{
  "apiUrl": "https://tu-dominio.com",
  "token": "ev2ag_..."
}
```

El `config.json` tiene la llave de esa PC: no lo subas a git ni lo mandes por chat.

### 5. Probar

```
cd C:\EV2\agent
node print-agent.js
```

Debe decir `conectado como "PC barra baja"`. Con eso, desde el panel del gerente
pícale **Imprimir prueba** a una impresora: el papel tiene que salir con acentos, con
la ñ y cortado.

### 6. Dejarlo arrancando solo

La forma más simple, sin instalar nada más: un acceso directo en la carpeta de
inicio.

1. Crea `iniciar-agente.bat` en `C:\EV2\agent`:

   ```bat
   @echo off
   cd /d C:\EV2\agent
   node print-agent.js >> agente.log 2>&1
   ```

2. `Win + R` → `shell:startup` → pega ahí un acceso directo al `.bat`.

Así arranca cuando alguien entra a Windows. Si prefieres que arranque **sin que
nadie inicie sesión**, usa el Programador de tareas: tarea nueva → "Ejecutar tanto si
el usuario inició sesión como si no" → desencadenador "Al iniciar el equipo" →
acción: `node.exe` con argumento `C:\EV2\agent\print-agent.js` y "Iniciar en"
`C:\EV2\agent`.

## Impresoras por USB (Windows)

Una impresora de red no necesita nada más que su IP. Una conectada por **USB** sí:
Windows no deja mandarle bytes crudos sin pasar por el spooler, y el spooler quiere
un recurso compartido.

1. Panel de control → Dispositivos e impresoras → clic derecho → Propiedades de
   impresora → pestaña **Compartir** → "Compartir esta impresora".
2. Ponle un **nombre corto y sin espacios**, por ejemplo `XP80`.
3. En el panel de EV2, da de alta la impresora con conexión **USB / Windows** y ese
   mismo nombre.

El agente que imprime en esa impresora tiene que ser el que corre **en esa misma
PC**.

## Qué hace cuando algo falla

| Qué pasó | Qué hace |
|---|---|
| La impresora está sin papel | Lo detecta antes de mandar el ticket y lo reporta con ese motivo |
| La impresora está apagada o desconectada | Reporta el fallo; el servidor lo reintenta |
| Falla varias veces seguidas | El servidor lo desvía a la otra impresora de esa barra |
| Se cae el internet del club | Sigue intentando; cuando vuelve, imprime lo que se acumuló |
| Apagan la PC a medio trabajo | El servidor devuelve ese trabajo a la cola a los dos minutos |
| El token es inválido | Se detiene y lo dice, en vez de insistir toda la noche |

Nada de eso se pierde en silencio: lo que no salió se ve en rojo en el panel del
gerente, y desde ahí se reimprime.

## Configuración completa

| Campo | Por omisión | Qué es |
|---|---|---|
| `apiUrl` | — | El dominio de tu servidor, sin barra final |
| `token` | — | El token del agente, del panel del gerente |
| `pollSeconds` | `3` | Cada cuánto pregunta si hay papel pendiente |
| `batch` | `5` | Cuántos trabajos se trae de una vez |
| `printTimeoutMs` | `15000` | Cuánto espera a una impresora antes de darla por muerta |
| `checkPaper` | `true` | Preguntarle a la impresora si tiene papel antes de imprimir |
| `paperCheckMs` | `500` | Cuánto espera esa respuesta antes de seguir de todos modos |

`EV2_API_URL` y `EV2_AGENT_TOKEN` como variables de entorno ganan sobre el archivo.

## Una limitación honesta

Con `checkPaper` en `false`, "impreso" significa **"la impresora aceptó los bytes"**,
no "el papel salió". El puerto 9100 acepta datos aunque el rollo esté vacío. Por eso
viene encendido: la consulta de papel es lo que hace que ese "impreso" sea verdad.
Las impresoras que no implementan la consulta no contestan, y entonces se dan por
buenas y se sigue — no saber no es lo mismo que estar sin papel.
