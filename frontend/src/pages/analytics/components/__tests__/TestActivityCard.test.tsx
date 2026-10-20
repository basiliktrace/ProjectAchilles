import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TestActivityCard from '../TestActivityCard';
import type { EnrichedTestExecution } from '@/services/api/analytics';

const exec = (timestamp: string, name: string) =>
  ({ test_uuid: name, test_name: name, timestamp, is_protected: true }) as unknown as EnrichedTestExecution;

describe('TestActivityCard', () => {
  it('counts executions from executionCount and takes last run from the latest execution', () => {
    render(
      <TestActivityCard
        executionCount={17055}
        recentTests={[exec('2026-10-10T12:00:00.000Z', 'older'), exec('2026-10-18T12:00:00.000Z', 'newer')]}
      />,
    );
    expect(screen.getByText('17,055 tests · last run Sun, Oct 18')).toBeInTheDocument();
  });

  it('falls back to the plain description without executions', () => {
    render(<TestActivityCard executionCount={null} recentTests={[]} />);
    expect(screen.getByText('Latest executions in window')).toBeInTheDocument();
  });
});
