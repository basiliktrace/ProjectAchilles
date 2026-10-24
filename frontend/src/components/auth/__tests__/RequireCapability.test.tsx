import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const caps = vi.hoisted(() => ({ value: { campaigns: false, loaded: true } as Record<string, boolean> }));
vi.mock('@/hooks/useCapabilities', () => ({ useCapabilities: () => caps.value }));

import { RequireCapability } from '../RequireCapability';

function renderAt() {
  return render(
    <MemoryRouter initialEntries={['/campaigns']}>
      <Routes>
        <Route path="/campaigns" element={<RequireCapability capability="campaigns"><div>campaigns page</div></RequireCapability>} />
        <Route path="/dashboard" element={<div>dashboard page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireCapability', () => {
  it('redirects when loaded and capability is false', () => {
    caps.value = { campaigns: false, loaded: true };
    renderAt();
    expect(screen.getByText('dashboard page')).toBeInTheDocument();
  });
  it('renders nothing and does not redirect before capabilities load', () => {
    caps.value = { campaigns: false, loaded: false };
    renderAt();
    expect(screen.queryByText('dashboard page')).toBeNull();
    expect(screen.queryByText('campaigns page')).toBeNull();
  });
  it('renders children when the capability is true', () => {
    caps.value = { campaigns: true, loaded: true };
    renderAt();
    expect(screen.getByText('campaigns page')).toBeInTheDocument();
  });
});
