import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TestMetadata } from '@/types/test';

const mk = (uuid: string, severity: string): TestMetadata => ({
  uuid,
  name: `test ${uuid}`,
  techniques: [],
  isMultiStage: false,
  stages: [],
  severity,
  category: 'intel-driven',
});

vi.mock('@/services/api/browser', () => ({
  browserApi: {
    getAllTests: vi.fn(async () => [mk('a', 'critical'), mk('b', 'high'), mk('c', 'low')]),
    getBuiltTestUuids: vi.fn(async () => []),
  },
}));
vi.mock('@/services/api/analytics', () => ({
  analyticsApi: { getExecutedTestUuids: vi.fn(async () => []) },
}));
vi.mock('@/hooks/useTestPreferences', () => ({
  useTestPreferences: () => ({
    favorites: new Set<string>(),
    recentTests: [],
    isFavorite: () => false,
    toggleFavorite: vi.fn(),
  }),
}));
vi.mock('@/hooks/useAppRole', () => ({ useHasPermission: () => false }));
vi.mock('@/hooks/useAnalyticsAuth', () => ({ useAnalyticsAuth: () => ({ configured: false }) }));
vi.mock('@/hooks/useMediaQuery', () => ({ useIsDesktop: () => true }));
vi.mock('@/components/browser/execution', () => ({ ExecutionDrawer: () => null }));

import TestsPage from '../TestsPage';

describe('TestsPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ignores a legacy ?severity= link and lists every test', async () => {
    render(
      <MemoryRouter initialEntries={['/?severity=critical']}>
        <TestsPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === '3/3 tests')).toBeTruthy());
  });
});
