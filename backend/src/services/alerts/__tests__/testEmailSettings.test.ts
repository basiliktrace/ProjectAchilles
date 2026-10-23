import { describe, it, expect } from 'vitest';
import { resolveTestEmailSettings, isMaskedSecret } from '../testEmailSettings.js';
import type { EmailAlertSettings } from '../../../types/integrations.js';

const saved: EmailAlertSettings = {
  smtp_host: 'box.example.com',
  smtp_port: 465,
  smtp_secure: true,
  smtp_user: 'alerts@example.com',
  smtp_pass: 'saved-secret',
  from_address: 'alerts@example.com',
  recipients: ['soc@example.com'],
  configured: true,
  enabled: true,
};

/** What AlertsConfig sends after the dialog is reopened: no password, masked user. */
const reopenedForm = {
  smtp_host: 'box.example.com',
  smtp_port: 465,
  smtp_secure: true,
  smtp_user: '****.com',
  from_address: 'alerts@example.com',
  recipients: ['soc@example.com'],
  enabled: true,
};

describe('resolveTestEmailSettings', () => {
  it('reuses the saved user and password when the form leaves them blank or masked', () => {
    const s = resolveTestEmailSettings(reopenedForm, saved)!;
    expect(s.smtp_user).toBe('alerts@example.com');
    expect(s.smtp_pass).toBe('saved-secret');
    expect(s.smtp_host).toBe('box.example.com');
  });

  it('prefers values typed in the form', () => {
    const s = resolveTestEmailSettings(
      { ...reopenedForm, smtp_user: 'new@example.com', smtp_pass: 'typed', smtp_port: 587, smtp_secure: false },
      saved,
    )!;
    expect(s.smtp_user).toBe('new@example.com');
    expect(s.smtp_pass).toBe('typed');
    expect(s.smtp_port).toBe(587);
    expect(s.smtp_secure).toBe(false);
  });

  it('never sends the saved credentials to a different host', () => {
    const s = resolveTestEmailSettings({ ...reopenedForm, smtp_host: 'attacker.example.net' }, saved)!;
    expect(s.smtp_host).toBe('attacker.example.net');
    expect(s.smtp_pass).toBe('');
    expect(s.smtp_user).toBe('');
  });

  it('treats the host comparison case-insensitively and ignores surrounding spaces', () => {
    const s = resolveTestEmailSettings({ ...reopenedForm, smtp_host: ' BOX.example.com ' }, saved)!;
    expect(s.smtp_pass).toBe('saved-secret');
  });

  it('falls back to saved settings when the form sends no email section', () => {
    expect(resolveTestEmailSettings(undefined, saved)).toEqual(saved);
  });

  it('uses the form alone when nothing is saved', () => {
    const s = resolveTestEmailSettings({ ...reopenedForm, smtp_user: 'u', smtp_pass: 'p' }, undefined)!;
    expect(s.smtp_user).toBe('u');
    expect(s.smtp_pass).toBe('p');
  });

  it('returns undefined when neither side has anything', () => {
    expect(resolveTestEmailSettings(undefined, undefined)).toBeUndefined();
  });
});

describe('isMaskedSecret', () => {
  it('recognises the GET /alerts mask format', () => {
    expect(isMaskedSecret('****')).toBe(true);
    expect(isMaskedSecret('****.com')).toBe(true);
    expect(isMaskedSecret('user@example.com')).toBe(false);
    expect(isMaskedSecret(undefined)).toBe(false);
  });
});
