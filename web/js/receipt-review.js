/**
 * EV2 — revisar lo que el programa leyó de la foto del ticket, antes de guardarlo.
 *
 * Esta es la mitad importante de la foto del ticket. Leer la imagen es lo llamativo;
 * lo que evita que el inventario se envenene es esta pantalla: qué renglones hay que
 * mirar, en qué orden, y qué NO se puede guardar todavía.
 *
 * Tres reglas, y las tres son a propósito:
 *
 *  1. **Nada se guarda sin insumo.** El programa propone un insumo del catálogo por
 *     parecido de nombre; si no está seguro, el renglón se queda SIN insumo, y así no
 *     pasa la validación de `receiving.js` —la misma que un renglón capturado a mano—.
 *     Adivinar mete la botella equivocada al estante, y eso no se descubre hasta el
 *     conteo.
 *
 *  2. **Los dudosos van primero.** Un ticket de quince renglones con doce claros y
 *     tres dudosos se revisa en dos minutos si los tres están arriba, y en veinte si
 *     hay que buscarlos.
 *
 *  3. **Lo leído se puede corregir siempre.** El borrador que sale de aquí es el mismo
 *     que el de la captura a mano, con los mismos campos editables. Cada renglón
 *     conserva el texto tal como se leyó y si la cuenta cuadró (`read.math`), porque
 *     un número que se comprobó solo y uno que hay que ir a ver al papel no valen lo
 *     mismo.
 *
 * Sin DOM y sin red: son reglas, y se prueban en Node.
 */
/* global module */
(function (root, factory) {
  'use strict';
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  root.EV2ReceiptReview = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

  /** ¿Cómo va la lectura de esta foto? Es lo primero que ve quien la subió. */
  const STATUS = {
    pending: { key: 'rc.stPending', done: false, usable: false },
    parsed: { key: 'rc.stParsed', done: false, usable: true },
    failed: { key: 'rc.stFailed', done: false, usable: false },
    used: { key: 'rc.stUsed', done: true, usable: false },
    discarded: { key: 'rc.stDiscarded', done: true, usable: false },
  };

  const statusOf = (status) => STATUS[String(status || '')]
    || { key: 'rc.stUnknown', done: false, usable: false };

  /**
   * El orden de la revisión: primero lo que hay que mirar.
   *
   * `low` arriba, luego `medium`, y al final lo que cuadró solo. Dentro de cada grupo
   * se conserva el orden del ticket, porque quien revisa va comparando con el papel y
   * reordenar los claros lo obligaría a buscar.
   */
  const RANK = { low: 0, medium: 1, high: 2 };

  function sortForReview(lines) {
    return (lines || []).map((line, i) => ({ line, i }))
      .sort((a, b) => (RANK[a.line.confidence] ?? 0) - (RANK[b.line.confidence] ?? 0)
        || a.i - b.i)
      .map((x) => x.line);
  }

  /**
   * Lo que se leyó → renglones de captura, con la marca de dónde salió cada número.
   *
   * `mode: 'packages'` siempre: una factura cobra por presentación completa —dos
   * botellas a 900— nunca por mililitro. Capturarlo como unidad base convertiría "2
   * botellas" en "2 ml" y el inventario diría que entraron dos mililitros de tequila.
   */
  function draftFromPhoto(parsed) {
    const lines = (parsed && parsed.lines) || [];
    return sortForReview(lines).map((line) => ({
      supply_id: line.supply_id || null,
      mode: 'packages',
      amount: line.quantity !== null && line.quantity !== undefined ? String(line.quantity) : '',
      package_cost: line.unit_cost !== null && line.unit_cost !== undefined
        ? String(Math.round(Number(line.unit_cost) * 100) / 100) : '',
      // De aquí en adelante es contexto de la revisión, no del renglón: la pantalla lo
      // usa para pintar y `receiptRequest` lo ignora.
      read: {
        text: line.text || '',
        description: line.description || '',
        confidence: line.confidence || 'low',
        math: line.math || 'incomplete',
        line_total: line.line_total ?? null,
        candidates: line.candidates || [],
        suggested_name: line.supply_name || null,
      },
    }));
  }

  /**
   * Qué le falta a este renglón para poder guardarse.
   *
   * Devuelve una lista de códigos, no un booleano: la pantalla los pinta junto al
   * campo que le falta, y "revisa el renglón 9" sin decir qué es lo mismo que nada.
   */
  function lineIssues(line) {
    const out = [];
    const l = line || {};
    if (!l.supply_id) out.push('no_supply');
    const cantidad = num(l.amount);
    if (cantidad === null) out.push('no_quantity');
    else if (!(cantidad > 0)) out.push('bad_quantity');
    const costo = num(l.package_cost);
    if (costo !== null && !(costo >= 0)) out.push('bad_cost');
    // Un renglón SIN costo se marca solo si vino de la foto. Tecleado a mano, no
    // poner costo es una decisión —hay entregas sin factura a la vista—; leído de un
    // papel que sí traía precios, significa que el programa no pudo con esa cifra, y
    // guardarlo así deja el costo promedio de ese insumo sin actualizar.
    if (costo === null && l.read) out.push('no_cost');
    // La cuenta que no cuadró se avisa aunque todo esté lleno: es la señal de que un
    // dígito se leyó mal, y es justo el renglón que hay que comparar con el papel.
    if (l.read && l.read.math === 'mismatch') out.push('math_mismatch');
    return out;
  }

  /** Un renglón que quien revisa dejó en blanco: no se manda y no estorba. */
  function isBlank(line) {
    const l = line || {};
    return !l.supply_id && (l.amount === '' || l.amount === null || l.amount === undefined)
      && (l.package_cost === '' || l.package_cost === null || l.package_cost === undefined);
  }

  /**
   * El resumen de arriba: cuántos renglones, cuántos por revisar, y si la suma cuadra
   * con el papel.
   *
   * `total_gap` es la parte que no se puede sacar mirando los renglones: si el ticket
   * dice 5,939 y los renglones suman 5,786, el programa se comió uno entero. Es la
   * única forma de notarlo antes de guardar.
   */
  function summary(parsed, lines) {
    const list = (lines || []).filter((l) => !isBlank(l));
    const revisar = list.filter((l) => lineIssues(l).length > 0).length;
    const suma = list.reduce((acc, l) => {
      const cantidad = num(l.amount);
      const costo = num(l.package_cost);
      return acc + (cantidad !== null && costo !== null ? cantidad * costo : 0);
    }, 0);
    const papel = parsed && parsed.compared_against !== undefined
      ? parsed.compared_against : (parsed && parsed.document_subtotal) ?? null;
    const total = Math.round(suma * 100) / 100;
    return {
      lines: list.length,
      to_review: revisar,
      total,
      paper_total: papel,
      total_gap: papel === null || papel === undefined
        ? null : Math.round((papel - total) * 100) / 100,
      // Con dos centavos de diferencia nadie va a buscar nada: es el redondeo del
      // papel. Con más, falta o sobra un renglón.
      total_matches: papel === null || papel === undefined
        ? null : Math.abs(papel - total) <= Math.max(0.02, Math.abs(papel) * 0.005),
    };
  }

  return {
    STATUS,
    statusOf,
    RANK,
    sortForReview,
    draftFromPhoto,
    lineIssues,
    isBlank,
    summary,
  };
}));
