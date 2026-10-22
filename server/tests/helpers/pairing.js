// El código de alta de una PC en las pruebas (D127).
//
// El panel ya no emite el código de 8 letras: la PC se registra con el instalador de
// "Registrar esta PC", que lleva la llave adentro. Muchas pruebas del agente solo
// necesitan una PC dada de alta con su lugar y su estación; esto emite esa llave directo
// con el servicio, igual que lo hace el instalador, y contesta con la forma de antes.
'use strict';

const { pool } = require('../../src/db/pool');
const printing = require('../../src/services/printing');

async function coverOf(nightclubId) {
  const { rows } = await pool.query(
    `SELECT id FROM supply_locations WHERE nightclub_id = $1 AND kind = 'door' AND active
      ORDER BY sort_order, code LIMIT 1`, [nightclubId]);
  return rows[0] ? rows[0].id : null;
}

async function invite(nightclubId, user, body = {}) {
  let locationId = body.location_id || null;
  let purpose = body.purpose || null;
  const st = body.station ? { ...body.station } : null;
  if (st) {
    if (st.purpose === 'door') { locationId = await coverOf(nightclubId); st.purpose = 'till'; }
    if (st.till_id) {
      const { rows } = await pool.query('SELECT location_id FROM tills WHERE id = $1', [st.till_id]);
      locationId = rows[0].location_id;
      if (st.purpose !== 'orders') st.purpose = 'till';
    }
    purpose = st.purpose;
  }
  const inv = await printing.createInvite(pool, {
    nightclubId, createdBy: user.id, locationId, purpose,
    station: st ? {
      name: st.name, purpose: st.purpose,
      drawer_pin: st.has_drawer ? (st.drawer_pin || 2) : null,
      ...(st.till_id ? { till_id: st.till_id } : {}),
    } : null,
  });
  return { status: 201, body: { invite: inv } };
}

module.exports = { invite };
