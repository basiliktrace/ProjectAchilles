import type { EmailAlertSettings } from '../../types/integrations.js';

/** The form posts this shape: every field optional, password usually blank. */
export type EmailTestInput = Partial<EmailAlertSettings>;

/**
 * True for the value GET /api/integrations/alerts returns in place of a
 * secret (`****` + last 4 chars). A reopened settings form echoes it back,
 * so it must never be treated as a real username.
 */
export function isMaskedSecret(value: string | undefined): boolean {
  return !!value && value.startsWith('****');
}

const sameHost = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Settings for "Test Channels": the form's values over the saved ones, field
 * by field, the same way saving merges them. Blank or masked credentials
 * fall back to the saved ones, but only while the host is unchanged, so a
 * test can never hand the stored password to a different server.
 */
export function resolveTestEmailSettings(
  form: EmailTestInput | undefined,
  saved: EmailAlertSettings | undefined,
): EmailAlertSettings | undefined {
  if (!form) return saved;

  const host = form.smtp_host?.trim() || saved?.smtp_host || '';
  const savedCreds = saved && sameHost(host, saved.smtp_host) ? saved : undefined;
  const formUser = isMaskedSecret(form.smtp_user) ? '' : form.smtp_user;

  return {
    smtp_host: host,
    smtp_port: form.smtp_port ?? saved?.smtp_port ?? 587,
    smtp_secure: form.smtp_secure ?? saved?.smtp_secure ?? false,
    smtp_user: formUser || savedCreds?.smtp_user || '',
    smtp_pass: form.smtp_pass || savedCreds?.smtp_pass || '',
    from_address: form.from_address || saved?.from_address || '',
    recipients: form.recipients ?? saved?.recipients ?? [],
    configured: false,
    enabled: form.enabled ?? saved?.enabled ?? false,
  };
}
