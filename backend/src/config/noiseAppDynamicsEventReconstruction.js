const NOISE_APPDYNAMICS_EVENT_RECONSTRUCTION_CONFIG = Object.freeze({
  reconstructionVersion: '4.4A.2',
  cacheTtlMs: 5 * 60 * 1000,
  maxTimelinePoints: 240,
  transientMaximumMs: 60 * 1000,
  compatibleGapMs: 2 * 60 * 1000,
});

module.exports = { NOISE_APPDYNAMICS_EVENT_RECONSTRUCTION_CONFIG };
