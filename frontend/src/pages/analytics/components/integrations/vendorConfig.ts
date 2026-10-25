// Per-vendor copy and defaults for the shared integration (CrowdStrike / Defender) tab components.

import { crowdstrikeApi } from '@/services/api/crowdstrike';
import { defenderApi } from '@/services/api/defender';

import type { IntegrationApi } from '@/services/api/integrationTypes';

export type { TimeWindow } from '@/services/api/integrationTypes';

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
  api: IntegrationApi;
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
