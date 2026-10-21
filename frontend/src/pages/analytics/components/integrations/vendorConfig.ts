// Per-vendor copy and defaults for the shared integration (CrowdStrike / Defender) tab components.

import { crowdstrikeApi } from '@/services/api/crowdstrike';
import { defenderApi } from '@/services/api/defender';

export type { TimeWindow } from '@/services/api/crowdstrike';

export type VendorId = 'crowdstrike' | 'defender';

export interface SeveritySegment {
  key: string;
  label: string;
  /** null = no severity filter. */
  severities: string[] | null;
}

export interface IntegrationVendor {
  id: VendorId;
  alertsTitle: string;
  portalLabel: string;
  responseLabel: string;
  knownSeverities: string[];
  severitySegments: SeveritySegment[];
  defaultSeverityKey: string;
  api: {
    getAlerts: typeof crowdstrikeApi.getAlerts | typeof defenderApi.getAlerts;
    getAlertTrend: typeof crowdstrikeApi.getAlertTrend | typeof defenderApi.getAlertTrend;
    getAlertSummary: typeof crowdstrikeApi.getAlertSummary | typeof defenderApi.getAlertSummary;
    getTechniqueCoverage: typeof crowdstrikeApi.getTechniqueCoverage | typeof defenderApi.getTechniqueCoverage;
  };
}

export const VENDORS: Record<VendorId, IntegrationVendor> = {
  crowdstrike: {
    id: 'crowdstrike',
    alertsTitle: 'Falcon Alerts',
    portalLabel: 'Open in Falcon console',
    responseLabel: 'Falcon response',
    knownSeverities: ['critical', 'high', 'medium', 'low', 'informational'],
    severitySegments: [
      { key: 'all', label: 'All severities', severities: null },
      { key: 'hc', label: 'High & critical', severities: ['critical', 'high'] },
    ],
    defaultSeverityKey: 'all',
    api: {
      getAlerts: crowdstrikeApi.getAlerts,
      getAlertTrend: crowdstrikeApi.getAlertTrend,
      getAlertSummary: crowdstrikeApi.getAlertSummary,
      getTechniqueCoverage: crowdstrikeApi.getTechniqueCoverage,
    },
  },
  defender: {
    id: 'defender',
    alertsTitle: 'Defender Alerts',
    portalLabel: 'Open in Defender portal',
    responseLabel: 'Defender response',
    knownSeverities: ['high', 'medium', 'low', 'informational'],
    severitySegments: [
      { key: 'hm', label: 'High & medium', severities: ['high', 'medium'] },
      { key: 'all', label: 'All severities', severities: null },
    ],
    defaultSeverityKey: 'hm',
    api: {
      getAlerts: defenderApi.getAlerts,
      getAlertTrend: defenderApi.getAlertTrend,
      getAlertSummary: defenderApi.getAlertSummary,
      getTechniqueCoverage: defenderApi.getTechniqueCoverage,
    },
  },
};
