// Per-vendor copy and defaults for the shared integration (CrowdStrike / Defender / SentinelOne) tab components.

import { crowdstrikeApi } from '@/services/api/crowdstrike';
import { defenderApi } from '@/services/api/defender';
import { sentineloneAnalyticsApi } from '@/services/api/sentineloneAnalytics';

import type { IntegrationApi } from '@/services/api/integrationTypes';

export type { TimeWindow } from '@/services/api/integrationTypes';

export type VendorId = 'crowdstrike' | 'defender' | 'sentinelone';

export interface SeveritySegment {
  key: string;
  label: string;
  /** null = no severity filter. */
  severities: string[] | null;
}

/** Optional record-type filter (e.g. SentinelOne threats vs detection alerts). */
export interface AlertTypeSegment {
  key: string;
  label: string;
  /** null = no filter. */
  sourceType: string | null;
}

export interface IntegrationVendor {
  id: VendorId;
  alertsTitle: string;
  portalLabel: string;
  responseLabel: string;
  knownSeverities: string[];
  severitySegments: SeveritySegment[];
  defaultSeverityKey: string;
  alertTypeSegments?: AlertTypeSegment[];
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
  sentinelone: {
    id: 'sentinelone',
    alertsTitle: 'SentinelOne Alerts',
    portalLabel: 'Open in SentinelOne console',
    responseLabel: 'SentinelOne response',
    knownSeverities: ['critical', 'high', 'medium', 'low', 'informational'],
    severitySegments: [
      { key: 'all', label: 'All severities', severities: null },
      { key: 'hc', label: 'High & critical', severities: ['critical', 'high'] },
    ],
    defaultSeverityKey: 'all',
    alertTypeSegments: [
      { key: 'all', label: 'All types', sourceType: null },
      { key: 'threats', label: 'Threats', sourceType: 'threats' },
      { key: 'alerts', label: 'Detection alerts', sourceType: 'cloud_detection_alerts' },
    ],
    api: {
      getAlerts: sentineloneAnalyticsApi.getAlerts,
      getAlertTrend: sentineloneAnalyticsApi.getAlertTrend,
      getAlertSummary: sentineloneAnalyticsApi.getAlertSummary,
      getTechniqueCoverage: sentineloneAnalyticsApi.getTechniqueCoverage,
    },
  },
};
