import { ShieldAlert, ShieldCheck } from 'lucide-react';
import type { CrowdStrikeAlertItem } from '@/services/api/crowdstrike';
import { formatPreventionAction } from '../utils/crowdstrikePrevention';

type PreventionBadgeAlert = Pick<
  CrowdStrikeAlertItem,
  'prevention_action' | 'pattern_disposition_description'
>;

/**
 * Vendor-confirmed prevention badge for a CrowdStrike alert row. Renders the
 * derived action (icon + label, semantic tokens) with the raw
 * pattern_disposition_description as the tooltip for audit context.
 * 'kill_failed' is styled as a warning — Falcon attempted prevention and
 * failed, which is a detection signal, not prevention.
 */
export default function CrowdStrikePreventionBadge({ alert }: { alert: PreventionBadgeAlert }) {
  const label = formatPreventionAction(alert.prevention_action);
  if (!label) return null;
  const failed = alert.prevention_action === 'kill_failed';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${
        failed
          ? 'border-warning/30 bg-warning-dim text-warning'
          : 'border-accent/30 bg-accent-dim text-accent'
      }`}
      title={alert.pattern_disposition_description ?? undefined}
    >
      {failed ? <ShieldAlert className="w-3 h-3" /> : <ShieldCheck className="w-3 h-3" />}
      {label}
    </span>
  );
}
