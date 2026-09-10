/**
 * EV2 — la ilustración que le toca a cada producto de la carta.
 *
 * Los 129 productos salen de la caja con nombre y precio, y ninguno con foto. Un menú
 * de 129 renglones de texto en un teléfono, a oscuras, es una lista de teléfono: el
 * cliente no encuentra nada y termina pidiéndole al mesero. Una imagen por renglón
 * convierte esa lista en una carta.
 *
 * Se dibujan en código, no se descargan:
 *
 *   * pesan menos que una foto y se ven nítidas en cualquier pantalla;
 *   * funcionan sin señal, que es la condición normal adentro del club;
 *   * y sobre todo no fingen ser lo que no son. Una foto de banco de imágenes puesta
 *     como si fuera el Azulito de la casa es una mentira pequeña que el cliente
 *     descubre en cuanto le llega la copa.
 *
 * **La foto real siempre gana.** El día que el club fotografíe sus bebidas, basta con
 * llenar `image_url` y ese producto se ve con su foto; el resto sigue ilustrado. Por
 * eso `artFor` decide entre foto e ilustración, y la pantalla solo obedece.
 *
 * Son vasos y botellas genéricos a propósito: ni etiquetas, ni logos, ni marcas. Lo que
 * distingue a un Don Julio de un Buchanan's en esta carta es su nombre, no un dibujo de
 * su etiqueta — que además no sería nuestro.
 *
 * Sin DOM a propósito: todo esto se prueba en Node.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2DrinkArt = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Los colores salen de la paleta del club. El acento es lo único que cambia entre una
  // ilustración y otra: el trazo siempre es el mismo blanco tenue, para que la carta se
  // lea como una carta y no como una bolsa de estampas de colores.
  const INK = 'rgba(255,255,255,.82)';
  const ACCENT = {
    cyan: '#00BFFF',
    pink: '#FF1493',
    purple: '#9D00FF',
    gold: '#FFD700',
    lime: '#00FF00',
    amber: '#FFA23E',
    red: '#FF4444',
    ice: '#BFE9FF',
  };

  /**
   * Cada dibujo vive en un lienzo de 48×48. El líquido va primero y el cristal encima,
   * para que el trazo del vaso no quede tapado por el relleno.
   */
  const D = {
    // Copa de coctel: lo que se sirve derecho, sin refresco.
    coupe: (c) => `
      <path d="M12 12h24l-10 12v12" fill="none"/>
      <path d="M14.5 14h19l-8 9.5h-3z" fill="${c}" opacity=".55" stroke="none"/>
      <path d="M12 12h24l-10 12v12M20 40h12" />
      <circle cx="31" cy="10" r="2.5" fill="${c}" stroke="none"/>`,

    // Vaso alto: lo mezclado con refresco, que aquí es casi todo.
    highball: (c) => `
      <path d="M17 10h14l-1.5 30h-11z" fill="none"/>
      <path d="M17.8 20h12.6l-1 20h-10.6z" fill="${c}" opacity=".5" stroke="none"/>
      <path d="M17 10h14l-1.5 30h-11z"/>
      <path d="M18.4 20h11.4"/>
      <path d="M33 12l4-4" stroke="${c}"/>`,

    // Copa huracán: lo tropical, con su fruta.
    tropical: (c) => `
      <path d="M12 9h24c0 6-4.4 8-6.2 11.4-1.4 2.6-1.8 5.6-1.8 9.6v8h-8v-8c0-4-.4-7-1.8-9.6C16.4 17 12 15 12 9z" fill="none"/>
      <path d="M14.6 15h18.8c-1.4 2-3 3.4-4 5.4-.6 1.2-1 2.4-1.2 3.6h-8.4c-.2-1.2-.6-2.4-1.2-3.6-1-2-2.6-3.4-4-5.4z" fill="${c}" opacity=".62" stroke="none"/>
      <path d="M12 9h24c0 6-4.4 8-6.2 11.4-1.4 2.6-1.8 5.6-1.8 9.6v8h-8v-8c0-4-.4-7-1.8-9.6C16.4 17 12 15 12 9z"/>
      <path d="M16 38h16"/>
      <path d="M31 7l7-4" stroke="${c}" stroke-width="2.4"/>
      <path d="M36 12a6 6 0 0 0-12 0z" fill="${ACCENT.gold}" opacity=".92" stroke="none"/>
      <path d="M36 12a6 6 0 0 0-12 0zM30 12V6" />
      <path d="M27 9.4l1.4 2.6M33 9.4l-1.4 2.6" stroke="rgba(0,0,0,.32)"/>`,

    // Chabela: cerveza preparada, con su escarcha en el borde.
    michelada: (c) => `
      <path d="M16 16h16l-2 24H18z" fill="none"/>
      <path d="M16.5 21h15l-1.5 19H18z" fill="${c}" opacity=".62" stroke="none"/>
      <path d="M16 16h16l-2 24H18z"/>
      <path d="M15.2 15h17.6" stroke="rgba(255,255,255,.55)" stroke-width="3.4" stroke-linecap="round"/>
      <circle cx="19" cy="12.6" r="1" fill="${INK}" stroke="none"/>
      <circle cx="24" cy="11.9" r="1" fill="${INK}" stroke="none"/>
      <circle cx="29" cy="12.6" r="1" fill="${INK}" stroke="none"/>
      <path d="M32 15a5.5 5.5 0 0 1 5.5 5.5h-11A5.5 5.5 0 0 1 32 15z" fill="${ACCENT.lime}" opacity=".85" stroke="none"/>
      <path d="M32 15a5.5 5.5 0 0 1 5.5 5.5h-11A5.5 5.5 0 0 1 32 15z"/>
      <path d="M32 15v5.5" stroke="rgba(0,0,0,.35)"/>`,

    // Cerveza de botella.
    beer_bottle: (c) => `
      <path d="M21 6h6v6l3 5v23a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V17l3-5z" fill="none"/>
      <path d="M18 24h12v14a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2z" fill="${c}" opacity=".55" stroke="none"/>
      <path d="M21 6h6v6l3 5v23a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V17l3-5z"/>
      <path d="M21 6h6" stroke-width="3" stroke-linecap="round"/>
      <rect x="19.5" y="26" width="9" height="7" rx="1" fill="rgba(0,0,0,.3)" stroke="none"/>`,

    // Cubeta: la cerveza por litro, con hielo.
    bucket: (c) => `
      <path d="M15 24V13a2 2 0 0 1 1-1.7V8h3v3.3a2 2 0 0 1 1 1.7v11z" fill="rgba(255,255,255,.12)"/>
      <path d="M15 24V13a2 2 0 0 1 1-1.7V8h3v3.3a2 2 0 0 1 1 1.7v11z"/>
      <path d="M22 24V11a2 2 0 0 1 1-1.7V5.5h3V9.3a2 2 0 0 1 1 1.7v13z" fill="rgba(255,255,255,.12)"/>
      <path d="M22 24V11a2 2 0 0 1 1-1.7V5.5h3V9.3a2 2 0 0 1 1 1.7v13z"/>
      <path d="M29 24V13a2 2 0 0 1 1-1.7V7.5h3V11.3a2 2 0 0 1 1 1.7v11z" fill="rgba(255,255,255,.12)"/>
      <path d="M29 24V13a2 2 0 0 1 1-1.7V7.5h3V11.3a2 2 0 0 1 1 1.7v11z"/>
      <path d="M9 23h30l-3.2 17.5a2.4 2.4 0 0 1-2.4 2H14.6a2.4 2.4 0 0 1-2.4-2z" fill="${c}" opacity=".5" stroke="none"/>
      <path d="M9 23h30l-3.2 17.5a2.4 2.4 0 0 1-2.4 2H14.6a2.4 2.4 0 0 1-2.4-2z"/>
      <path d="M9 26.5c1.6 1.6 3.2-1 4.8.6s3.2-1 4.8.6 3.2-1 4.8.6 3.2-1 4.8.6 3.2-1 4.8.6" stroke="rgba(255,255,255,.5)"/>`,

    // Vaso bajo: lo que se pide en las rocas, con su hielo.
    rocks: (c) => `
      <path d="M14 15h20l-2 24a2 2 0 0 1-2 1.8H18a2 2 0 0 1-2-1.8z" fill="none"/>
      <path d="M14.8 24h18.4l-1.2 15a2 2 0 0 1-2 1.8H18a2 2 0 0 1-2-1.8z" fill="${c}" opacity=".5" stroke="none"/>
      <path d="M14 15h20l-2 24a2 2 0 0 1-2 1.8H18a2 2 0 0 1-2-1.8z"/>
      <rect x="18" y="19" width="8" height="8" rx="1.5" transform="rotate(-12 22 23)" fill="rgba(255,255,255,.22)" stroke="rgba(255,255,255,.5)"/>
      <rect x="25" y="24" width="7" height="7" rx="1.5" transform="rotate(14 28.5 27.5)" fill="rgba(255,255,255,.18)" stroke="rgba(255,255,255,.45)"/>`,

    // Caballito.
    shot: (c) => `
      <path d="M17 12h14l-2 20a3 3 0 0 1-3 2.6h-4A3 3 0 0 1 19 32z" fill="none"/>
      <path d="M17.9 21h12.2l-1.1 11a3 3 0 0 1-3 2.6h-4A3 3 0 0 1 19 32z" fill="${c}" opacity=".65" stroke="none"/>
      <path d="M17 12h14l-2 20a3 3 0 0 1-3 2.6h-4A3 3 0 0 1 19 32z"/>
      <path d="M18.2 21h11.6"/>
      <path d="M20 39h8"/>`,

    // Ronda: varios caballitos, que es como se venden.
    shot_flight: (c) => `
      <path d="M7 15h11l-1.6 16a2.4 2.4 0 0 1-2.4 2.1h-3A2.4 2.4 0 0 1 8.6 31z" fill="${c}" opacity=".45" stroke="none"/>
      <path d="M7 15h11l-1.6 16a2.4 2.4 0 0 1-2.4 2.1h-3A2.4 2.4 0 0 1 8.6 31z"/>
      <path d="M18.5 15h11l-1.6 16a2.4 2.4 0 0 1-2.4 2.1h-3a2.4 2.4 0 0 1-2.4-2.1z" fill="${c}" opacity=".7" stroke="none"/>
      <path d="M18.5 15h11l-1.6 16a2.4 2.4 0 0 1-2.4 2.1h-3a2.4 2.4 0 0 1-2.4-2.1z"/>
      <path d="M30 15h11l-1.6 16a2.4 2.4 0 0 1-2.4 2.1h-3A2.4 2.4 0 0 1 31.6 31z" fill="${c}" opacity=".45" stroke="none"/>
      <path d="M30 15h11l-1.6 16a2.4 2.4 0 0 1-2.4 2.1h-3A2.4 2.4 0 0 1 31.6 31z"/>
      <path d="M6 38h36"/>`,

    // Botella de licor. El hombro alto y recto es lo que la distingue del tequila.
    bottle_spirit: (c) => `
      <path d="M20 5h8v8c0 2 4 4 4 9v22a3 3 0 0 1-3 3h-10a3 3 0 0 1-3-3V22c0-5 4-7 4-9z" fill="none"/>
      <path d="M16 26h16v18a3 3 0 0 1-3 3h-10a3 3 0 0 1-3-3z" fill="${c}" opacity=".5" stroke="none"/>
      <path d="M20 5h8v8c0 2 4 4 4 9v22a3 3 0 0 1-3 3h-10a3 3 0 0 1-3-3V22c0-5 4-7 4-9z"/>
      <path d="M20 5h8" stroke-width="3" stroke-linecap="round"/>
      <rect x="17.5" y="28" width="13" height="9" rx="1.5" fill="rgba(0,0,0,.32)" stroke="none"/>`,

    // Botella de tequila: cuello largo y cuerpo cónico.
    bottle_agave: (c) => `
      <path d="M21.6 9h4.8v12c0 3 4.6 4.2 4.6 10v14a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3V31c0-5.8 4.6-7 4.6-10z" fill="none"/>
      <path d="M17 32h14v13a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3z" fill="${c}" opacity=".5" stroke="none"/>
      <path d="M21.6 9h4.8v12c0 3 4.6 4.2 4.6 10v14a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3V31c0-5.8 4.6-7 4.6-10z"/>
      <path d="M21.4 5.4h5.2a1.2 1.2 0 0 1 1.2 1.2v2.4h-7.6V6.6a1.2 1.2 0 0 1 1.2-1.2z" fill="${ACCENT.amber}" opacity=".9" stroke="none"/>
      <path d="M21.4 5.4h5.2a1.2 1.2 0 0 1 1.2 1.2v2.4h-7.6V6.6a1.2 1.2 0 0 1 1.2-1.2z"/>
      <path d="M17.4 34.5h13.2"/>`,

    // Champaña: la botella ancha y la burbuja.
    bottle_sparkling: (c) => `
      <path d="M21 4h6v9c0 4 6 6 6 14v14a4 4 0 0 1-4 4h-10a4 4 0 0 1-4-4V27c0-8 6-10 6-14z" fill="none"/>
      <path d="M15 30h18v11a4 4 0 0 1-4 4h-10a4 4 0 0 1-4-4z" fill="${c}" opacity=".5" stroke="none"/>
      <path d="M21 4h6v9c0 4 6 6 6 14v14a4 4 0 0 1-4 4h-10a4 4 0 0 1-4-4V27c0-8 6-10 6-14z"/>
      <path d="M20.5 3.5h7a1.5 1.5 0 0 1 0 3h-7a1.5 1.5 0 0 1 0-3z" fill="${c}" stroke="none"/>
      <circle cx="37" cy="14" r="2" fill="${c}" opacity=".9" stroke="none"/>
      <circle cx="41" cy="9" r="1.3" fill="${c}" opacity=".7" stroke="none"/>
      <circle cx="39" cy="20" r="1" fill="${c}" opacity=".6" stroke="none"/>`,

    // Agua: vaso limpio, sin adorno.
    water: (c) => `
      <path d="M17 11h14l-2 29H19z" fill="none"/>
      <path d="M18.2 22h11.6l-1.2 18h-9.2z" fill="${c}" opacity=".45" stroke="none"/>
      <path d="M17 11h14l-2 29H19z"/>
      <path d="M18.4 22h11.2"/>`,

    // Jugo: vaso con popote y su rebanada.
    juice: (c) => `
      <path d="M17 14h14l-2 26H19z" fill="none"/>
      <path d="M17.5 19h13l-1.5 21H19z" fill="${c}" opacity=".65" stroke="none"/>
      <path d="M17 14h14l-2 26H19z"/>
      <path d="M27 12l6-5" stroke="${c}" stroke-width="2.6"/>
      <path d="M12 16a5 5 0 0 0 10 0z" fill="${c}" opacity=".85" stroke="none"/>
      <path d="M12 16a5 5 0 0 0 10 0z"/>`,

    // Refresco: lata.
    soda: (c) => `
      <rect x="16" y="9" width="16" height="31" rx="3" fill="none"/>
      <path d="M16 20h16v17a3 3 0 0 1-3 3h-10a3 3 0 0 1-3-3z" fill="${c}" opacity=".55" stroke="none"/>
      <rect x="16" y="9" width="16" height="31" rx="3"/>
      <path d="M16.5 14h15M16.5 20h15"/>
      <circle cx="24" cy="11.5" r="1.4" fill="${INK}" stroke="none"/>`,

    // Energética: lata alta con su rayo.
    energy: (c) => `
      <rect x="17" y="6" width="14" height="35" rx="3" fill="none"/>
      <path d="M17 18h14v20a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3z" fill="${c}" opacity=".55" stroke="none"/>
      <rect x="17" y="6" width="14" height="35" rx="3"/>
      <path d="M25.5 20l-4.5 8h3.5l-1.5 7 5-9h-3.5z" fill="${c}" stroke="none"/>`,

    // Paquete: lo que no se bebe — pulseras, paquetes de cumpleaños.
    package: (c) => `
      <rect x="8" y="18" width="32" height="22" rx="3" fill="none"/>
      <rect x="8" y="18" width="32" height="22" rx="3"/>
      <path d="M6 14h36v7H6z" fill="${c}" opacity=".6" stroke="none"/>
      <path d="M6 14h36v7H6z"/>
      <path d="M24 14v26" stroke="${c}"/>
      <path d="M24 14c-6 0-9-3-9-6s6-2 9 6c3-8 9-9 9-6s-3 6-9 6z" fill="${c}" opacity=".7"/>`,
  };

  /**
   * Qué ilustración usa cada tipo, con su acento.
   *
   * El acento no es decoración: agrupa la carta de un vistazo. Todo lo de tequila tira a
   * ámbar, lo de vodka a hielo, la cerveza a oro, lo tropical a rosa. Con el pulgar
   * bajando la lista, el color dice de qué familia es antes de leer el nombre.
   */
  const KINDS = {
    coupe: { draw: D.coupe, accent: ACCENT.cyan },
    highball: { draw: D.highball, accent: ACCENT.purple },
    tropical: { draw: D.tropical, accent: ACCENT.pink },
    michelada: { draw: D.michelada, accent: ACCENT.red },
    beer_bottle: { draw: D.beer_bottle, accent: ACCENT.gold },
    bucket: { draw: D.bucket, accent: ACCENT.gold },
    shot: { draw: D.shot, accent: ACCENT.amber },
    shot_flight: { draw: D.shot_flight, accent: ACCENT.pink },
    rocks: { draw: D.rocks, accent: ACCENT.amber },
    bottle_clear: { draw: D.bottle_spirit, accent: ACCENT.ice },
    bottle_amber: { draw: D.bottle_spirit, accent: ACCENT.amber },
    bottle_agave: { draw: D.bottle_agave, accent: ACCENT.amber },
    bottle_agave_clear: { draw: D.bottle_agave, accent: ACCENT.ice },
    bottle_sparkling: { draw: D.bottle_sparkling, accent: ACCENT.gold },
    water: { draw: D.water, accent: ACCENT.ice },
    juice: { draw: D.juice, accent: ACCENT.amber },
    soda: { draw: D.soda, accent: ACCENT.cyan },
    energy: { draw: D.energy, accent: ACCENT.lime },
    package: { draw: D.package, accent: ACCENT.pink },
  };

  /** Sin acentos y en mayúsculas: la carta viene de la caja escrita a mano. */
  function clave(texto) {
    return String(texto == null ? '' : texto)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toUpperCase();
  }

  const tiene = (n, ...palabras) => palabras.some((p) => n.includes(p));

  /**
   * De qué está hecha una botella, por su nombre.
   *
   * Son las marcas que el club vende de verdad. Lo que no reconoce cae en la botella
   * genérica, que es lo honesto: inventarle una forma a algo que no conocemos solo
   * sirve para dibujar mal.
   */
  function familiaDeBotella(n) {
    if (tiene(n, 'CHAMPAGNE', 'MOET', 'PERIGNON', 'NUVO', 'HPNOTIQ')) return 'bottle_sparkling';
    if (tiene(n, 'TEQUILA', 'DON JULIO', '30-30', 'HERRADURA', 'CLASE AZUL', 'MAESTRO TEQUILERO',
      'GRAN MALO', '1800', 'MEZCAL', 'BACANORA', '400 CONEJOS')) {
      // Un blanco es transparente y un añejo es ámbar: pintarlos igual sería dibujar
      // algo que no es. En una lista de cuatro 30-30 seguidos, eso es lo único que las
      // distingue de un vistazo.
      return tiene(n, 'BLANCO', 'CRISTALINO', 'PLATA', 'SILVER', 'JOVEN')
        ? 'bottle_agave_clear' : 'bottle_agave';
    }
    // Mismo dibujo, distinto color: el whisky y el ron añejo son ámbar, el vodka y la
    // ginebra son transparentes. Con 48 botellas en la lista, el color es lo que
    // permite encontrar la tuya sin leerlas todas.
    if (tiene(n, 'BUCHANANS', 'LABEL', 'JACK DANIELS', 'TORRES', 'JAGERMEISTER',
      'CAPTAIN MORGAN', 'CAPITAN MORGAN', 'WHISKY', 'WHISKEY', 'BRANDY', 'COGNAC',
      'ANEJO', 'AZUL MANGO')) return 'bottle_amber';
    return 'bottle_clear';
  }

  /**
   * Qué se dibuja para este producto. El nombre manda sobre la categoría: en la carta
   * real, `CUB. TECATE ROJA` y `TECATE ROJA` viven en el mismo grupo y no son lo mismo.
   */
  function kindFor(drink) {
    const n = clave(drink && drink.name);
    const cat = clave(drink && drink.category);

    // Lo que no se bebe.
    if (tiene(n, 'PULSERA', 'PUL.', 'PAQUETE', 'COVER', 'MESA')) return 'package';

    // Se sirve por litro, en hielo.
    if (n.startsWith('CUB.') || tiene(n, 'CUBETA', 'CUBETAZO')) return 'bucket';
    if (tiene(n, 'MICHELADA', 'CLAMATO', 'CHELADA')) return 'michelada';

    // Shots: la ronda es varias copas, el shot es una.
    if (tiene(n, 'RONDA')) return 'shot_flight';
    if (n.startsWith('SHOT') || tiene(n, 'SHOT ', 'PERLA NEGRA')) return 'shot';

    if (cat.includes('CERVEZA')) return 'beer_bottle';
    if (cat.includes('BOTELLA')) return familiaDeBotella(n);

    if (cat.includes('SIN ALCOHOL') || cat.includes('SERVICIO')) {
      if (tiene(n, 'AGUA')) return 'water';
      if (tiene(n, 'JUGO')) return 'juice';
      if (tiene(n, 'MONSTER', 'RED BULL', 'BOOST', 'ENERG')) return 'energy';
      return 'soda';
    }

    // Cocteles.
    // "En las rocas" es literal: el licor solo, sobre hielo, en vaso bajo.
    if (tiene(n, 'EN LAS ROCAS', 'ON THE ROCKS', 'DERECHO')) return 'rocks';
    if (tiene(n, 'COLADA', 'TROPICAL', 'MANGO', 'PIÑA', 'PINA', 'COCO', 'SANDIA', 'BANANA',
      'MARACUYA', 'FRESA', 'BELLAKEO')) return 'tropical';
    // Un nombre con guion es una mezcla: licor con refresco, que va en vaso alto.
    if (n.includes(' - ') || tiene(n, 'COCA COLA', 'SPRITE', 'MINERAL', 'SQUIRT', 'TONIC')) {
      return 'highball';
    }
    return 'coupe';
  }

  /**
   * Lo que la pantalla tiene que pintar para este producto.
   *
   * Si el producto tiene foto, la foto: nadie prefiere un dibujo cuando existe la cosa
   * real. Si no, la ilustración que le toca.
   */
  function artFor(drink) {
    const photo = drink && typeof drink.image_url === 'string' ? drink.image_url.trim() : '';
    if (photo) return { type: 'photo', url: photo };
    const kind = kindFor(drink);
    return { type: 'art', kind, accent: KINDS[kind].accent };
  }

  /**
   * El SVG, listo para meter en la página.
   *
   * Sale con `aria-hidden`: el nombre del producto ya está escrito al lado, y que un
   * lector de pantalla lea "copa de coctel" antes de cada renglón solo estorba.
   */
  function svgFor(drink, size = 48) {
    const art = artFor(drink);
    if (art.type === 'photo') return '';
    const k = KINDS[art.kind];
    return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true" focusable="false"`
      + ` fill="none" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">`
      + `${k.draw(k.accent)}</svg>`;
  }

  return {
    KINDS,
    ACCENT,
    INK,
    kindFor,
    artFor,
    svgFor,
    kindNames: () => Object.keys(KINDS),
  };
}));
