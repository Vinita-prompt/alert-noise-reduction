UPDATE noise_rules
SET threshold = '5 open/recover state changes in 15 min', updated_at = NOW()
WHERE rule_key = 'flapping-alerts';

UPDATE noise_rules
SET threshold = 'Resolved within 12 min with no repeat for 10 min', updated_at = NOW()
WHERE rule_key = 'auto-resolved-alerts';

UPDATE noise_rules
SET threshold = 'Single low-impact event with no runbook action', updated_at = NOW()
WHERE rule_key = 'non-actionable-alerts';

UPDATE noise_rules
SET threshold = 'Shared dependency or region within 20 min', updated_at = NOW()
WHERE rule_key = 'correlated-alerts';

UPDATE noise_rules
SET threshold = 'No source heartbeat or service ownership for 7 days', updated_at = NOW()
WHERE rule_key = 'stale-alerts';
