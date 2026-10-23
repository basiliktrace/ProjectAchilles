import { useEffect, useState } from 'react';
import { CheckCircle, Send } from 'lucide-react';
import { noticesApi } from '@/services/api/notices';
import type { NoticeTestResult } from '@/services/api/notices';
import { Input } from '@/components/shared/ui/Input';
import { Button } from '@/components/shared/ui/Button';
import { Alert } from '@/components/shared/ui/Alert';
import { Spinner } from '@/components/shared/ui/Spinner';

interface PreExecutionNoticesConfigProps {
  onStatusChange?: (enabled: boolean) => void;
}

const parseRecipients = (raw: string): string[] =>
  raw.split(/[,\n;]+/).map((r) => r.trim()).filter(Boolean);

export function PreExecutionNoticesConfig({ onStatusChange }: PreExecutionNoticesConfigProps) {
  const [enabled, setEnabled] = useState(false);
  const [recipients, setRecipients] = useState('');
  const [leadMinutes, setLeadMinutes] = useState('5');
  const [maxWait, setMaxWait] = useState('60');
  const [pickupWindow, setPickupWindow] = useState('120');
  const [sendFinished, setSendFinished] = useState(true);
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [lastCheck, setLastCheck] = useState<{ at?: string; ok?: boolean; message?: string } | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<NoticeTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    noticesApi
      .getSettings()
      .then((s) => {
        setEnabled(s.enabled);
        setRecipients(s.recipients.join(', '));
        setLeadMinutes(String(s.lead_minutes));
        setMaxWait(String(s.max_wait_minutes));
        setPickupWindow(String(s.pickup_window_minutes));
        setSendFinished(s.send_finished);
        setSmtpConfigured(s.smtp_configured);
        if (s.last_smtp_check_at) {
          setLastCheck({ at: s.last_smtp_check_at, ok: s.last_smtp_check_ok, message: s.last_smtp_check_message });
        }
        onStatusChange?.(s.enabled);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load settings'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      setSuccessMessage(null);
      const saved = await noticesApi.saveSettings({
        enabled,
        recipients: parseRecipients(recipients),
        lead_minutes: Number(leadMinutes),
        max_wait_minutes: Number(maxWait),
        pickup_window_minutes: Number(pickupWindow),
        send_finished: sendFinished,
      });
      setSmtpConfigured(saved.smtp_configured);
      setSuccessMessage('Pre-execution notice settings saved.');
      onStatusChange?.(saved.enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    try {
      setTesting(true);
      setError(null);
      setTestResult(null);
      setTestResult(await noticesApi.sendTest());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test notice failed');
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner size="md" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {successMessage && (
        <Alert variant="success">
          <CheckCircle className="w-4 h-4" />
          {successMessage}
        </Alert>
      )}

      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Before security tests run, email the recipients below and hold the tests until the mail
          server accepts the notice.
        </p>

        <div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!smtpConfigured}
              onChange={(e) => setEnabled(e.target.checked)}
              className="rounded border-border"
            />
            Enable pre-execution notices
          </label>
          {!smtpConfigured && (
            <p className="mt-1 text-xs text-muted-foreground">Configure SMTP email in Alerts first</p>
          )}
        </div>

        <div className="w-full">
          <label htmlFor="notice-recipients" className="block text-sm font-medium mb-1.5 text-foreground">
            Recipients
          </label>
          <textarea
            id="notice-recipients"
            rows={2}
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
            placeholder="secops@example.com, oncall@example.com"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Comma or newline separated (max 50). Save before sending a test notice.
          </p>
        </div>

        <Input
          label="Lead time (minutes)"
          type="number"
          min={0}
          max={5}
          value={leadMinutes}
          onChange={(e) => setLeadMinutes(e.target.value)}
          helperText="Delay between the notice being accepted and tests starting (0–5)"
        />
        <Input
          label="Max wait for delivery (minutes)"
          type="number"
          min={15}
          max={1440}
          value={maxWait}
          onChange={(e) => setMaxWait(e.target.value)}
          helperText="Give up and skip the run if the notice is not accepted in this time (15–1440)"
        />
        <Input
          label="Pickup window (minutes)"
          type="number"
          min={30}
          max={1440}
          value={pickupWindow}
          onChange={(e) => setPickupWindow(e.target.value)}
          helperText="How long agents have to pick up tests after release (30–1440)"
        />

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={sendFinished}
            onChange={(e) => setSendFinished(e.target.checked)}
            className="rounded border-border"
          />
          Send a finished email when the run completes
        </label>
      </div>

      {lastCheck && (
        <p className={`text-sm ${lastCheck.ok === false ? 'text-danger' : 'text-muted-foreground'}`}>
          Last SMTP check: {lastCheck.ok === false ? 'failed' : 'ok'}
          {lastCheck.at ? ` at ${new Date(lastCheck.at).toLocaleString()}` : ''}
          {lastCheck.message ? ` — ${lastCheck.message}` : ''}
        </p>
      )}

      {testResult && (
        <Alert variant={testResult.fully_accepted ? 'success' : 'destructive'}>
          <div className="space-y-0.5">
            <p>Accepted: {testResult.accepted.join(', ') || 'none'}</p>
            <p>Rejected: {testResult.rejected.join(', ') || 'none'}</p>
          </div>
        </Alert>
      )}

      {error && <Alert variant="destructive">{error}</Alert>}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={handleTest} disabled={testing || !smtpConfigured}>
          {testing ? (
            <>
              <Spinner size="sm" />
              Sending...
            </>
          ) : (
            <>
              <Send className="w-4 h-4" />
              Send test notice
            </>
          )}
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <>
              <Spinner size="sm" />
              Saving...
            </>
          ) : (
            'Save Settings'
          )}
        </Button>
      </div>
    </div>
  );
}
