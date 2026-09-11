const MONITORING_SOURCE_DEFINITIONS = [
  {
    id: 'nagios-dc01',
    label: 'Nagios DC01',
    adapterName: 'Nagios DC01 Adapter',
    integrationTool: 'nagios-dc01',
    sourceInstance: 'dc01',
    category: 'Infrastructure',
    authType: 'token',
    aliases: ['nagios dc01', 'nagios-dc01', 'dc01 nagios', 'dc01'],
    description: 'Host and service alerts from the DC01 Nagios environment.',
  },
  {
    id: 'nagios-dc02',
    label: 'Nagios DC02',
    adapterName: 'Nagios DC02 Adapter',
    integrationTool: 'nagios-dc02',
    sourceInstance: 'dc02',
    category: 'Infrastructure',
    authType: 'token',
    aliases: ['nagios dc02', 'nagios-dc02', 'dc02 nagios', 'dc02'],
    description: 'Host and service alerts from the DC02 Nagios environment.',
  },
  {
    id: 'payment-gateway',
    label: 'Payment Gateway',
    adapterName: 'Payment Gateway Adapter',
    integrationTool: 'payment-gateway',
    sourceInstance: 'payments',
    category: 'Business Platform',
    authType: 'api-key',
    aliases: ['payment gateway', 'payment-gateway', 'payments', 'verifone'],
    description: 'Payment provider and transaction processing alerts.',
  },
  {
    id: 'oracle-apex',
    label: 'Oracle APEX',
    adapterName: 'Oracle APEX Adapter',
    integrationTool: 'oracle-apex',
    sourceInstance: 'apex',
    category: 'Business Platform',
    authType: 'browser-session',
    aliases: ['apex dashboard', 'apex-dashboard', 'apex', 'oracle apex', 'oracle-apex', 'pf etl dashboard'],
    description: 'Read-only Oracle APEX PF & ETL Dashboard monitoring data.',
  },
  {
    id: 'appdynamics',
    label: 'AppDynamics',
    adapterName: 'AppDynamics Adapter',
    integrationTool: 'splunk-appdynamics',
    sourceInstance: 'appdynamics',
    category: 'Application Performance',
    authType: 'oauth',
    aliases: ['appdynamics', 'appd', 'splunk appdynamics', 'splunk-appdynamics'],
    description: 'Application health rule and event signals from Splunk AppDynamics.',
  },
  {
    id: 'grafana',
    label: 'Grafana',
    adapterName: 'Grafana Adapter',
    integrationTool: 'grafana',
    sourceInstance: 'grafana',
    category: 'Observability',
    authType: 'bearer',
    aliases: ['grafana'],
    description: 'Alert rules and dashboard-managed signals from Grafana.',
  },
  {
    id: 'abc-hub',
    label: 'ABC Hub',
    adapterName: 'ABC Hub Adapter',
    integrationTool: 'abc-hub',
    sourceInstance: 'abc-hub',
    category: 'Internal Platform',
    authType: 'token',
    aliases: ['abc hub', 'abc-hub', 'abchub', 'hub'],
    description: 'Internal ABC Hub operational notifications and platform alerts.',
  },
];

function normalizeSourceValue(value) {
  return String(value || '').toLowerCase().replace(/[\s_-]+/g, '');
}

function getMonitoringSourceDefinitions() {
  return MONITORING_SOURCE_DEFINITIONS.map((definition) => ({
    ...definition,
    aliases: [...definition.aliases],
  }));
}

function getMonitoringSourceDefinition(sourceKey) {
  const normalized = normalizeSourceValue(sourceKey);

  return MONITORING_SOURCE_DEFINITIONS.find((definition) => {
    const values = [definition.id, definition.label, definition.integrationTool, ...definition.aliases];

    return values.some((value) => normalizeSourceValue(value) === normalized);
  }) || null;
}

function sourceMatchesDefinition(alert, definition) {
  const values = [
    alert.source,
    alert.source_tool,
    alert.source_name,
    alert.source_instance,
    alert.application,
    alert.monitoring_system_name,
    alert.custom_source_tool,
    alert.custom_source_instance,
  ].map(normalizeSourceValue);

  const aliases = [
    definition.id,
    definition.label,
    definition.integrationTool,
    definition.sourceInstance,
    ...definition.aliases,
  ].map(normalizeSourceValue);

  return aliases.some((alias) => values.some((value) => value && value.includes(alias)));
}

module.exports = {
  getMonitoringSourceDefinition,
  getMonitoringSourceDefinitions,
  normalizeSourceValue,
  sourceMatchesDefinition,
};
