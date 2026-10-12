/**
 * Las decisiones de la puerta, del lado de la pantalla.
 *
 * Quien las usa está de pie, de noche, con una fila enfrente. Lo que se prueba es
 * que el resultado se pueda leer de reojo y que nadie cobre de más — no que se vea
 * bonito.
 */
'use strict';

const path = require('path');

const Scan = require(path.join(__dirname, '..', '..', 'web', 'js', 'door-scan.js'));

const respuesta = (result, over = {}) => ({
  pass: {
    result,
    reservation_id: 'r1',
    guest: { name: 'Ana López' },
    table: { code: '39', section: 'ZONA ROJA' },
    guest_count: 8,
    extras_bought: 0,
    ...over,
  },
});

describe('cómo se enseña cada resultado', () => {
  it('el que abre es verde y el que no existe es rojo', () => {
    expect(Scan.view(respuesta('ok')).tone).toBe('ok');
    expect(Scan.view(respuesta('not_found')).tone).toBe('bad');
    expect(Scan.view(respuesta('cancelled')).tone).toBe('bad');
  });

  it('lo que se arregla hablando es ámbar, no rojo', () => {
    // Rojo significa "no entra". Decirle eso a quien solo debe su anticipo, o a
    // quien se equivocó de noche, lo manda a su casa por nada.
    for (const motivo of ['unpaid', 'not_tonight', 'already_in']) {
      expect(Scan.view(respuesta(motivo)).tone).toBe('warn');
    }
  });

  it('cada resultado tiene su frase, ninguno cae en una genérica', () => {
    const vistos = new Set();
    for (const motivo of Object.keys(Scan.RESULTS)) {
      const v = Scan.view(respuesta(motivo));
      expect(v.headlineKey).toBeTruthy();
      vistos.add(v.headlineKey);
    }
    expect(vistos.size).toBe(Object.keys(Scan.RESULTS).length);
  });

  it('una respuesta sin pase se trata como código inexistente, no revienta', () => {
    expect(Scan.view({ result: 'not_found', ok: false }).tone).toBe('bad');
    expect(Scan.view(null).result).toBe('not_found');
    expect(Scan.view({}).ok).toBe(false);
  });

  it('un resultado que no conocemos no se pinta de verde', () => {
    // Si el servidor añade un motivo nuevo, lo peor sería dejar pasar a alguien.
    const v = Scan.view(respuesta('motivo_del_futuro'));
    expect(v.ok).toBe(false);
    expect(v.tone).toBe('bad');
  });

  it('trae lo que la puerta necesita leer: quién, qué mesa, cuántos', () => {
    const v = Scan.view(respuesta('ok'));
    expect(v.guest).toBe('Ana López');
    expect(v.table).toBe('39');
    expect(v.guestCount).toBe(8);
  });
});

describe('vender la entrada', () => {
  it('el total se calcula en centavos enteros', () => {
    expect(Scan.total(3, 150)).toBe('450.00');
    expect(Scan.total(1, 0)).toBe('0.00');
    // 0.1 + 0.2 en float da 0.30000000000000004; en centavos, no.
    expect(Scan.total(3, 0.1)).toBe('0.30');
  });

  it('la cantidad se acota: ni cero, ni negativa, ni doscientos', () => {
    expect(Scan.admissionPayload('general', { quantity: 0, unitPrice: 150 }).quantity).toBe(1);
    expect(Scan.admissionPayload('general', { quantity: -5, unitPrice: 150 }).quantity).toBe(1);
    expect(Scan.admissionPayload('general', { quantity: 200, unitPrice: 150 }).quantity).toBe(50);
  });

  it('un acceso general no lleva reservación', () => {
    const body = Scan.admissionPayload('general', { quantity: 2, unitPrice: 150, reservationId: 'r1' });
    expect(body).not.toHaveProperty('reservation_id');
  });

  it('un extra sí la lleva: si no, es dinero que no se le puede cobrar a nadie', () => {
    const body = Scan.admissionPayload('vip_extra', { quantity: 2, unitPrice: 100, reservationId: 'r1' });
    expect(body.reservation_id).toBe('r1');
  });

  it('sin precio no se vende', () => {
    expect(Scan.sellBlocker('general', { unitPrice: '' })).toBe('sell.errPrice');
    expect(Scan.sellBlocker('general', { unitPrice: null })).toBe('sell.errPrice');
    expect(Scan.sellBlocker('general', { unitPrice: 0 })).toBeNull();
  });

  it('un extra sin pase leído no se vende', () => {
    expect(Scan.sellBlocker('vip_extra', { unitPrice: 100 })).toBe('sell.errNoPass');
    expect(Scan.sellBlocker('vip_extra', { unitPrice: 100, reservationId: 'r1' })).toBeNull();
  });

  it('solo un pase que ya entró puede comprar extras', () => {
    expect(Scan.canSellExtra(Scan.view(respuesta('ok')))).toBe(true);
    expect(Scan.canSellExtra(Scan.view(respuesta('already_in')))).toBe(true);
    // A quien no ha entrado no se le cobra un extra: todavía no hay mesa ocupada.
    expect(Scan.canSellExtra(Scan.view(respuesta('not_tonight')))).toBe(false);
    expect(Scan.canSellExtra(Scan.view(respuesta('not_found')))).toBe(false);
    expect(Scan.canSellExtra(null)).toBe(false);
  });

  it('el importe se redondea a centavos antes de viajar', () => {
    const body = Scan.admissionPayload('general', { quantity: 1, unitPrice: 150.005 });
    expect(body.unit_price).toBe(150.01);
  });

  it('las formas de pago son las que el servidor acepta', () => {
    expect(Scan.METHODS).toEqual(['cash', 'card', 'transfer', 'courtesy']);
    expect(Scan.admissionPayload('general', { unitPrice: 150 }).payment_method).toBe('cash');
  });
});

// ---------------------------------------------------------------- el precio y el doble toque

describe('el precio ya no lo pone la puerta', () => {
  it('con un cover escogido viaja su id y NINGÚN importe', () => {
    // Es la diferencia entera: el servidor busca el precio en su catálogo en vez de
    // creerse el número que venga en el cuerpo.
    const body = Scan.admissionPayload('general', {
      quantity: 2, unitPrice: 150, coverPriceId: 'c-1',
    });
    expect(body.cover_price_id).toBe('c-1');
    expect(body.unit_price).toBeUndefined();
  });

  it('con catálogo cargado, no se puede vender sin escoger uno', () => {
    const covers = [{ id: 'c-1', name: 'COVER', amount: '150.00' }];
    expect(Scan.sellBlocker('general', { unitPrice: 150, covers })).toBe('sell.errPickCover');
    expect(Scan.sellBlocker('general', { unitPrice: 150, covers, coverPriceId: 'c-1' })).toBeNull();
  });

  it('sin catálogo todavía, la puerta sigue vendiendo con el importe tecleado', () => {
    // Un club que aún no carga sus covers no se puede quedar sin poder cobrar.
    expect(Scan.sellBlocker('general', { unitPrice: 150, covers: [] })).toBeNull();
    expect(Scan.sellBlocker('general', { unitPrice: '', covers: [] })).toBe('sell.errPrice');
  });

  it('un extra VIP se cobra a la tarifa de la noche, no a lo que se teclee', () => {
    const covers = [{ id: 'c-1', name: 'COVER', amount: '150.00' }];
    expect(Scan.sellBlocker('vip_extra', { reservationId: 'r1', covers })).toBeNull();
    expect(Scan.sellBlocker('vip_extra', { covers })).toBe('sell.errNoPass');
  });
});

describe('el doble toque de la puerta', () => {
  it('la clave del intento viaja en el cuerpo', () => {
    // Sin ella, la pantalla que se queda pensando con mal wifi vende dos entradas y
    // emite dos juegos de QR válidos.
    const body = Scan.admissionPayload('general', {
      quantity: 1, unitPrice: 150, clientRequestId: 'req-1',
    });
    expect(body.client_request_id).toBe('req-1');
  });

  it('sin clave no se inventa ninguna: la decide la pantalla, no este módulo', () => {
    const body = Scan.admissionPayload('general', { quantity: 1, unitPrice: 150 });
    expect('client_request_id' in body).toBe(false);
  });
});

describe('la cámara de la puerta', () => {
  const base = { hasGetUserMedia: true, hasBarcodeDetector: false, nativeFormats: null, hasJsQR: true };

  it('en iPhone (sin BarcodeDetector) la cámara funciona con jsQR', () => {
    expect(Scan.cameraMode(base)).toBe('jsqr');
  });

  it('con BarcodeDetector que lee QR se usa el nativo', () => {
    expect(Scan.cameraMode({ ...base, hasBarcodeDetector: true, nativeFormats: ['qr_code', 'ean_13'] }))
      .toBe('native');
  });

  it('un BarcodeDetector que NO lee QR no se usa: la cámara se vería y nunca leería', () => {
    expect(Scan.cameraMode({ ...base, hasBarcodeDetector: true, nativeFormats: ['ean_13'] })).toBe('jsqr');
    expect(Scan.cameraMode({
      ...base, hasBarcodeDetector: true, nativeFormats: ['ean_13'], hasJsQR: false,
    })).toBeNull();
  });

  it('sin getUserMedia (página sin HTTPS) no hay cámara que ofrecer', () => {
    expect(Scan.cameraMode({ ...base, hasGetUserMedia: false })).toBeNull();
  });

  it('cada falla de la cámara tiene su aviso, y el permiso negado no se confunde con "no puede"', () => {
    expect(Scan.cameraErrorKey({ name: 'NotAllowedError' })).toBe('scan.camDenied');
    expect(Scan.cameraErrorKey({ name: 'SecurityError' })).toBe('scan.camDenied');
    expect(Scan.cameraErrorKey({ name: 'NotFoundError' })).toBe('scan.camNotFound');
    expect(Scan.cameraErrorKey({ name: 'NotReadableError' })).toBe('scan.camBusy');
    expect(Scan.cameraErrorKey(new Error('x'))).toBe('scan.noCamera');
    expect(Scan.cameraErrorKey(null)).toBe('scan.noCamera');
  });

  it('el cuadro se reduce sin deformarse y no se agranda', () => {
    expect(Scan.frameSize(1920, 1080)).toEqual({ width: 640, height: 360 });
    expect(Scan.frameSize(720, 1280)).toEqual({ width: 360, height: 640 });
    expect(Scan.frameSize(320, 240)).toEqual({ width: 320, height: 240 });
    expect(Scan.frameSize(0, 0)).toBeNull();
  });

  it('cada aviso nuevo existe en español y en inglés', () => {
    const fs = require('fs');
    const fmt = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'js', 'format.js'), 'utf8');
    for (const k of ['scan.camDenied', 'scan.camNotFound', 'scan.camBusy']) {
      expect(fmt.split(`'${k}':`).length - 1).toBe(2);
    }
  });
});

describe('jsQR lee el QR que dibuja el servidor', () => {
  const QRCode = require('qrcode');
  const jsQR = require(path.join(__dirname, '..', '..', 'web', 'vendor', 'jsqr', 'jsQR.js'));

  /** Pinta los módulos del QR como lo vería la cámara: píxeles RGBA con margen blanco. */
  function rgba(texto, { escala = 6, margen = 4, invertido = false } = {}) {
    const qr = QRCode.create(texto, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const lado = (n + margen * 2) * escala;
    const data = new Uint8ClampedArray(lado * lado * 4);
    for (let y = 0; y < lado; y += 1) {
      for (let x = 0; x < lado; x += 1) {
        const mx = Math.floor(x / escala) - margen;
        const my = Math.floor(y / escala) - margen;
        const negro = Boolean(mx >= 0 && my >= 0 && mx < n && my < n && qr.modules.get(my, mx));
        const v = (negro !== invertido) ? 0 : 255;
        const i = (y * lado + x) * 4;
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
      }
    }
    return { data, lado };
  }

  it('el pase firmado sale tal cual, para que el servidor lo verifique', () => {
    const texto = 'EV2.K7M3-P9QX.ABCDEF1234567890';
    const { data, lado } = rgba(texto);
    expect(jsQR(data, lado, lado, { inversionAttempts: 'attemptBoth' }).data).toBe(texto);
  });

  it('el enlace de WhatsApp también se lee', () => {
    const texto = 'https://ev2clandestinoz.com/pase.html?p=EV2.K7M3-P9QX.ABCDEF1234567890';
    const { data, lado } = rgba(texto);
    expect(jsQR(data, lado, lado, { inversionAttempts: 'attemptBoth' }).data).toBe(texto);
  });

  it('un QR invertido (pantalla en modo oscuro) se lee con attemptBoth', () => {
    const texto = 'EV2.K7M3-P9QX.ABCDEF1234567890';
    const { data, lado } = rgba(texto, { invertido: true });
    expect(jsQR(data, lado, lado, { inversionAttempts: 'attemptBoth' }).data).toBe(texto);
  });
});
