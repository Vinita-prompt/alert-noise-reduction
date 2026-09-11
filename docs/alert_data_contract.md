# Alert Data Contract

This is the common format the system uses after reading a Slack alert.

## Required Fields

- `inputChannel`: where the alert came from, currently `Slack`
- `sourceTool`: Grafana, AppDynamics, Payment Gateway, APEX Dashboard, ThousandEyes, Nagios, or Unknown
- `alertName`: alert title or rule name
- `rawMessage`: original Slack message text
- `slack.channelId`: Slack channel ID
- `slack.messageTs`: Slack message timestamp

## Strongly Recommended Fields

- `service`: affected service, app, host, or node
- `environment`: prod, stage, uat, dev, or unknown
- `severity`: critical, high, warning, low, or unknown
- `status`: firing, resolved, or unknown
- `links`: source alert, dashboard, runbook, or related URLs

## Derived Fields

These are calculated by the parser and later alert engine.

- `domain`: Infrastructure, Application, Network, Dependency, or Unknown
- `businessImpact`: Business Critical, High Impact, Medium Impact, or Low Impact
- `actionability`: Actionable, Non-actionable, or Needs review
- `noiseHints`: early signs of duplicate, flapping, auto-resolved, stale, or non-actionable alerts

## Best Slack Alert Message Shape

Alerts are easier to classify when the Slack message includes clear key-value fields.

```text
Grafana Alert: High CPU Usage
service=payment-api
env=prod
severity=warning
status=firing
description=CPU above 90% for 5 minutes
```

The parser also works with normal text, but key-value fields make the results much more reliable.
