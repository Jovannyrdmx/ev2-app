// Price calculation. Always runs on the server: clients only display the result.
//
// Rules live in `pricing_rules` and are applied by ascending `priority`
// (lower number = applied later, so it wins). An 'override' rule replaces the
// running price, 'multiplier' scales it and 'fixed' adds to it.
'use strict';

const { pool } = require('../db/pool');

function ruleApplies(rule, when) {
  const dow = when.getUTCDay();
  if (Array.isArray(rule.days_of_week) && !rule.days_of_week.includes(dow)) return false;

  if (rule.date_from && when < new Date(`${rule.date_from}T00:00:00Z`)) return false;
  if (rule.date_to && when > new Date(`${rule.date_to}T23:59:59Z`)) return false;

  if (rule.time_from && rule.time_to) {
    const minutes = when.getUTCHours() * 60 + when.getUTCMinutes();
    const [fh, fm] = rule.time_from.split(':').map(Number);
    const [th, tm] = rule.time_to.split(':').map(Number);
    const from = fh * 60 + fm;
    const to = th * 60 + tm;
    // Windows that cross midnight (e.g. 22:00–02:00) are treated as continuous.
    const inWindow = from <= to ? (minutes >= from && minutes <= to) : (minutes >= from || minutes <= to);
    if (!inWindow) return false;
  }
  return true;
}

/**
 * @param {object} opts
 * @param {string} opts.nightclubId
 * @param {'table_type'|'section'|'drink_category'|'reservation'} opts.appliesTo
 * @param {string|null} opts.target      e.g. 'vip', 'main', 'cocktail'
 * @param {number} opts.basePrice
 * @param {Date} [opts.when]
 * @returns {Promise<{base: number, final: number, applied: Array}>}
 */
async function quote({ nightclubId, appliesTo, target, basePrice, when = new Date() }) {
  const { rows } = await pool.query(
    `SELECT id, name, applies_to, target, days_of_week, time_from, time_to, date_from, date_to,
            adjustment_type, value, priority
       FROM pricing_rules
      WHERE nightclub_id = $1 AND active AND applies_to = $2
        AND (target IS NULL OR target = $3)
      ORDER BY priority DESC`,
    [nightclubId, appliesTo, target],
  );

  let price = Number(basePrice);
  const applied = [];
  for (const rule of rows) {
    if (!ruleApplies(rule, when)) continue;
    const value = Number(rule.value);
    const before = price;
    if (rule.adjustment_type === 'override') price = value;
    else if (rule.adjustment_type === 'multiplier') price *= value;
    else price += value; // 'fixed'
    applied.push({
      id: rule.id, name: rule.name, type: rule.adjustment_type, value,
      before: Number(before.toFixed(2)), after: Number(price.toFixed(2)),
    });
  }

  return {
    base: Number(Number(basePrice).toFixed(2)),
    final: Number(Math.max(0, price).toFixed(2)),
    applied,
  };
}

module.exports = { quote, ruleApplies };
