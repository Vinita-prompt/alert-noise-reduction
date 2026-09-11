const db = require('../config/db');
const { retiredDecisionError } = require('../config/decisionLayer');

function mapRuleRow(row) {
  return {
    id: row.id,
    ruleKey: row.rule_key,
    name: row.name,
    description: row.description,
    status: row.status,
    threshold: row.threshold,
    reduction: row.reduction,
    retiredAt: row.retired_at,
    retirementReason: row.retirement_reason,
    legacy: true,
    authoritative: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getRules(request, response, next) {
  try {
    const result = await db.query(`
      SELECT id, rule_key, name, description, status, threshold, reduction,
             retired_at, retirement_reason, created_at, updated_at
      FROM noise_rules
      ORDER BY id ASC
    `);

    response.json({ data: result.rows.map(mapRuleRow) });
  } catch (error) {
    next(error);
  }
}

async function updateRuleStatus(request, response, next) {
  next(retiredDecisionError());
}

async function updateRule(request, response, next) {
  next(retiredDecisionError());
}

module.exports = {
  getRules,
  updateRule,
  updateRuleStatus,
};
