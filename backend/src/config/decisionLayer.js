const CURRENT_PHASE = 'UNIFIED_EVIDENCE_BASED_SHADOW_DECISION';
const RETIRED_AT = '2026-08-24';

const DECISION_LAYER_STATE = Object.freeze({
  currentPhase: CURRENT_PHASE,
  status: 'retired',
  retiredAt: RETIRED_AT,
  legacyDecisionFieldsAuthoritative: false,
  automaticClassificationEnabled: false,
  replacementClassifierEnabled: false,
  offlineShadowExperimentAllowed: true,
  productionMlDecisionsEnabled: false,
  sourceSpecificOutcomeReconstructionEnabled: true,
  liveMultiSourceEvaluationEnabled: true,
  unifiedEvidenceDecisionEnabled: true,
  unifiedEvidenceDecisionType: 'EXPERIMENTAL_SHADOW_SCAFFOLD',
  evidenceScoreCalibrated: false,
  liveEvaluationMode: 'SHADOW',
  modelReleaseStatus: 'NOT_READY',
  feedbackLearningEnabled: true,
  analyticalCandidatesOnly: true,
  nextPhase: 'GOLD_REVIEW_DATASET_AND_MODEL_EVALUATION',
  notYetImplemented: Object.freeze([
    'Production ML decisioning',
    'Production ML prediction',
    'Calibrated ML confidence',
    'Automatic source actions',
  ]),
});

function unclassifiedFoundationState() {
  return {
    classification: 'unclassified',
    noiseType: 'none',
    confidenceScore: null,
    noiseReason: null,
    classificationReason: null,
  };
}

function notEvaluatedMetadata() {
  return {
    status: 'not_evaluated',
    label: null,
    confidence: null,
    justification: null,
    reason_codes: [],
    recommended_action: null,
    classifier: null,
    legacy: false,
  };
}

function retiredDecisionError() {
  const error = new Error('The legacy alert decision layer is retired. This endpoint no longer generates Noise, Incident, or Needs Review decisions.');
  error.code = 'LEGACY_DECISION_LAYER_RETIRED';
  error.safeMessage = error.message;
  error.status = 410;
  return error;
}

module.exports = {
  CURRENT_PHASE,
  DECISION_LAYER_STATE,
  RETIRED_AT,
  notEvaluatedMetadata,
  retiredDecisionError,
  unclassifiedFoundationState,
};
