/**
 * Imprimir por USB sin compartir la impresora (D61).
 *
 * ---------------------------------------------------------------------------
 * Qué defecto real vigila este archivo
 * ---------------------------------------------------------------------------
 * La primera versión compartía la impresora en Windows y le copiaba el archivo a
 * `\\localhost\<nombre compartido>`. Eso obliga a que **dos** nombres coincidan letra
 * por letra: el del recurso compartido y el que un gerente tecleó en el panel. El 26
 * de septiembre de 2026 dejaron de coincidir en la PC de prueba y el agente contestó
 * `No se encuentra el nombre de red especificado` — un mensaje que no menciona
 * impresoras y que manda a buscar el problema a la red, donde no estaba.
 *
 * Ahora se abre la impresora por su propio nombre, a través de `winspool.drv`, con el
 * trabajo marcado `RAW` para que el driver no reinterprete el ESC/POS.
 *
 * ---------------------------------------------------------------------------
 * Por qué se prueba el TEXTO del programa y no su ejecución
 * ---------------------------------------------------------------------------
 * Porque esto corre en Linux, en CI y en el contenedor, y PowerShell con `winspool`
 * solo existe en Windows. Ejecutarlo de verdad es lo que hace
 * `herramientas/verificar-winspool.ps1` en la PC del club, y su salida queda en
 * `docs/AVANCE.md`. Lo que sí se puede vigilar desde aquí —y es donde se rompería sin
 * que nadie se diera cuenta— son las decisiones que hacen que ese programa funcione:
 * el tipo de datos `RAW`, que el nombre viaje por el entorno y no pegado en el texto,
 * y que no haya vuelto a aparecer ninguna dependencia del recurso compartido.
 */
'use strict';

const agent = require('../../agent/print-agent');

describe('El agente imprime sin recurso compartido (D61)', () => {
  const ps = agent.WINDOWS_PRINT_PS;

  it('ya no le copia nada a \\\\localhost', async () => {
    // Es el defecto entero en una línea. Si alguien reintroduce la copia al recurso
    // compartido, vuelve el mensaje que no dice nada.
    const fuente = agent.printToWindows.toString() + ps;
    expect(fuente).not.toMatch(/localhost/i);
    expect(fuente).not.toMatch(/copy\s+\/B/i);
  });

  it('abre el trabajo como RAW, que es lo único que respeta el ESC/POS', async () => {
    // Sin `RAW` el spooler pasa los bytes por el driver, que los toma por un
    // documento: sale papel, pero con basura en vez del ticket.
    expect(ps).toMatch(/pDataType\s*=\s*"RAW"/);
    expect(ps).toMatch(/winspool\.drv/);
    expect(ps).toMatch(/StartDocPrinter/);
    expect(ps).toMatch(/WritePrinter/);
  });

  it('el nombre de la impresora viaja por el entorno, no dentro del programa', async () => {
    // El nombre lo escribe una persona en el panel. Si se pegara dentro del texto,
    // un nombre con comillas podría ejecutar otra cosa en la PC de la barra.
    expect(ps).toMatch(/\$env:EV2_PRINTER_NAME/);
    expect(ps).toMatch(/\$env:EV2_PAYLOAD_PATH/);
  });

  it('acepta tanto el nombre de la impresora como el compartido', async () => {
    // Las instalaciones anteriores a D61 tienen el nombre COMPARTIDO guardado en el
    // panel. Si solo se aceptara el nombre propio, actualizar el agente dejaría de
    // imprimir a todas las PCs que ya estaban funcionando.
    expect(ps).toMatch(/\$_\.Name\s+-eq\s+\$pedido/);
    expect(ps).toMatch(/\$_\.ShareName\s+-eq\s+\$pedido/);
  });

  it('cuando no encuentra la impresora, dice cuáles hay instaladas', async () => {
    // El error viejo mandaba a revisar la red. Este manda a mirar la lista, que es
    // donde está el dedazo.
    expect(ps).toMatch(/ninguna impresora de esta PC se llama asi/);
    expect(ps).toMatch(/Instaladas/);
  });

  it('avisa de "sin conexión", que es el fallo que no se ve', async () => {
    // Con esa marca puesta el spooler ACEPTA el trabajo, lo deja en la cola y no sale
    // papel nunca. Sin este aviso, el agente reporta que imprimió y nadie entiende
    // por qué la barra no tiene tickets.
    expect(ps).toMatch(/WorkOffline/);
    expect(ps).toMatch(/OFFLINE/);
  });

  it('el agente distingue "salió bien" de "falló" por una marca, no por el código de salida',
    async () => {
      // PowerShell puede devolver 0 y haber escrito un error, o devolver otra cosa por
      // razones ajenas. La marca en la salida es lo que no se presta a interpretación.
      expect(ps).toMatch(/EV2-OK:/);
      expect(ps).toMatch(/EV2-ERR:/);
    });

  it('fuera de Windows lo dice en vez de intentarlo', async () => {
    if (process.platform === 'win32') return;
    await expect(agent.printToWindows({ windows_name: 'X' }, Buffer.from([1])))
      .rejects.toThrow(/Windows/i);
  });

  it('una impresora sin nombre guardado se para aquí, con palabras', async () => {
    // Es un renglón inconsistente en la base (la restricción lo impide, pero el
    // agente no puede contar con eso). El mensaje manda al panel, no a la red.
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      await expect(agent.printToWindows({ windows_name: '  ' }, Buffer.from([1])))
        .rejects.toThrow(/nombre de Windows/i);
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });
});

describe('El agente dice a qué barra atiende (D61)', () => {
  it('sin barra asignada dice que imprime todo el club', async () => {
    // No es un hueco sin llenar: es lo correcto para un club de una sola PC. En un
    // club de cuatro, esa misma frase es la señal de que a esta le falta su barra.
    expect(agent.areaLabel(null)).toMatch(/todo lo del club/i);
    expect(agent.areaLabel({})).toMatch(/todo lo del club/i);
  });

  it('con barra y propósito lo dice como lo diría una persona', async () => {
    expect(agent.areaLabel({ location_name: 'Barra planta baja', purpose: 'orders' }))
      .toBe('Barra planta baja · comandas de barra');
    expect(agent.areaLabel({ location_name: 'Barra planta alta', purpose: 'service' }))
      .toBe('Barra planta alta · comandas de meseros');
    expect(agent.areaLabel({ location_name: 'Barra planta baja', purpose: 'till' }))
      .toBe('Barra planta baja · recibos de caja');
  });

  it('con barra y sin propósito dice que imprime todo lo de esa barra', async () => {
    expect(agent.areaLabel({ location_name: 'Terraza', purpose: null }))
      .toBe('Terraza · todo');
  });
});
