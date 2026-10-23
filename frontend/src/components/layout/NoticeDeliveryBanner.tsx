import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useCapabilities } from '@/hooks/useCapabilities';
import { noticesApi, type NoticeStatus } from '@/services/api/notices';

const DISMISS_KEY = 'pa.noticeBanner.dismissed';
const POLL_MS = 60_000;

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function NoticeDeliveryBanner() {
  const { preExecutionNotices } = useCapabilities();
  const [status, setStatus] = useState<NoticeStatus | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    if (!preExecutionNotices || dismissed) return;
    let cancelled = false;
    const poll = () => {
      noticesApi
        .getStatus()
        .then((s) => { if (!cancelled) setStatus(s); })
        .catch(() => { /* keep the last known status */ });
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [preExecutionNotices, dismissed]);

  if (!preExecutionNotices || dismissed || !status) return null;
  const problem =
    status.pendingOverdue > 0 || status.notDeliveredLast7d > 0 || status.smtpCheck?.ok === false;
  if (!problem) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* storage unavailable: dismissal lasts until unmount */
    }
  };

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 border-b border-warning/30 bg-warning-dim px-4 py-2.5 text-sm text-warning lg:pl-[calc(15rem+1rem)]"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="flex-1">
        Test runs are waiting on, or were skipped for, notice email delivery. Check Settings →
        Integrations → Pre-execution notices.
      </p>
      <button type="button" onClick={dismiss} aria-label="Dismiss" className="shrink-0 rounded p-0.5 hover:bg-warning/20">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export default NoticeDeliveryBanner;
