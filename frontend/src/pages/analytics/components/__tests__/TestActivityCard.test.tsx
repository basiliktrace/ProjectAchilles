import { afterEach, describe, it, expect, vi } from 'vitest';
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

  describe('filling its row', () => {
    const originalRO = globalThis.ResizeObserver;
    const originalMM = window.matchMedia;
    afterEach(() => {
      globalThis.ResizeObserver = originalRO;
      window.matchMedia = originalMM;
    });

    it('renders up to 12 runs to measure on large screens', () => {
      globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
        unobserve() {}
      } as unknown as typeof ResizeObserver;
      window.matchMedia = vi.fn().mockReturnValue({
        matches: true,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as typeof window.matchMedia;
      const runs = Array.from({ length: 15 }, (_, i) => exec(`2026-10-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`, `run-${i}`));
      render(<TestActivityCard executionCount={15} recentTests={runs} />);
      expect(screen.getAllByText(/^run-\d+$/)).toHaveLength(12);
    });

    it('shows its default 4 runs when nothing can be measured', () => {
      const runs = Array.from({ length: 15 }, (_, i) => exec('2026-10-10T12:00:00.000Z', `run-${i}`));
      render(<TestActivityCard executionCount={15} recentTests={runs} />);
      expect(screen.getAllByText(/^run-\d+$/)).toHaveLength(4);
    });
  });
});
