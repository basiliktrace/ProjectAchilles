import { describe, it, expect } from 'vitest';
import { BundleControlResultSchema } from '../agent.schemas.js';

const base = {
  control_id: 'T1059.001', control_name: 'PowerShell', validator: 'Stage 1',
  exit_code: 101, compliant: false, severity: 'high', category: 'intel-driven',
  subcategory: '', techniques: ['T1059.001'], tactics: ['execution'],
  expected: '', actual: '', details: '', skipped: false, error_message: '',
};

describe('BundleControlResultSchema description', () => {
  it('keeps a stage description', () => {
    const parsed = BundleControlResultSchema.parse({ ...base, description: 'PowerShell recon' });
    expect(parsed.description).toBe('PowerShell recon');
  });

  it('still parses a control without a description (old agents)', () => {
    const parsed = BundleControlResultSchema.parse(base);
    expect(parsed.description).toBeUndefined();
  });
});
