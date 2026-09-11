const NOISE_SCORING_CONFIG = Object.freeze({
  dimensions: Object.freeze({
    repetitionFrequency: Object.freeze({ maximum: 25 }),
    duplicateBehavior: Object.freeze({ maximum: 15 }),
    recurringBehavior: Object.freeze({ maximum: 15 }),
    lifecycleBehavior: Object.freeze({ maximum: 15 }),
    autoResolution: Object.freeze({ maximum: 10 }),
    humanToil: Object.freeze({ maximum: 10 }),
    shortLived: Object.freeze({ maximum: 5 }),
    historicalOutcome: Object.freeze({ maximum: 5 }),
  }),
  highHumanToil: Object.freeze({ acknowledgementRate: 50, minimumAcknowledgements: 5 }),
  risk: Object.freeze({
    bands: Object.freeze({ critical: 90, high: 60, medium: 25 }),
    weights: Object.freeze({
      criticalSeverity: 90,
      crossSourceEvidence: 30,
      customerFacing: 10,
      incidentBacked: 35,
      longDuration: 15,
      p1: 90,
      p2: 40,
      problemBacked: 35,
      productionEnvironment: 5,
    }),
  }),
  scoreBands: Object.freeze({ high: 60, medium: 35 }),
});

module.exports = { NOISE_SCORING_CONFIG };
