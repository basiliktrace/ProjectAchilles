import { describe, it, expect } from 'vitest';
import { isSmtpUsable, isSlackUsable } from '../channels.js';

const email = {
  smtp_host: 'smtp.example.test',
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: 'u',
  smtp_pass: 'p',
  from_address: 'pa@example.test',
  recipients: [],
  configured: false,
  enabled: false,
};

describe('notice channel usability', () => {
  it('SMTP is usable from host + from_address, whatever the configured flag says', () => {
    expect(isSmtpUsable(email)).toBe(true);
    expect(isSmtpUsable({ ...email, configured: true })).toBe(true);
  });

  it('SMTP is not usable without a host or a from address', () => {
    expect(isSmtpUsable({ ...email, smtp_host: '   ' })).toBe(false);
    expect(isSmtpUsable({ ...email, from_address: '' })).toBe(false);
    expect(isSmtpUsable({ ...email, configured: true, smtp_host: '' })).toBe(false);
    expect(isSmtpUsable(undefined)).toBe(false);
    expect(isSmtpUsable(null)).toBe(false);
  });

  it('Slack is usable from webhook_url + enabled, whatever the configured flag says', () => {
    expect(isSlackUsable({ webhook_url: 'https://hooks.slack.test/x', enabled: true, configured: false })).toBe(true);
    expect(isSlackUsable({ webhook_url: 'https://hooks.slack.test/x', enabled: false, configured: true })).toBe(false);
    expect(isSlackUsable({ webhook_url: '', enabled: true, configured: true })).toBe(false);
    expect(isSlackUsable(undefined)).toBe(false);
  });
});
