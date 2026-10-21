import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useFitCount } from '../useFitCount';

type Size = { container: number; item: number };

let observers: Array<() => void> = [];
const sizes: Size = { container: 300, item: 40 };

class FakeResizeObserver {
  constructor(cb: () => void) {
    observers.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function stubRect(el: HTMLElement | null, key: keyof Size) {
  if (!el) return;
  el.getBoundingClientRect = () => ({ height: sizes[key] }) as DOMRect;
}

function Probe({ min = 3, max = 10, fallback = 5, gap = 8 }) {
  const { containerRef, itemRef, count } = useFitCount({ min, max, fallback, gap });
  return (
    <div
      ref={(el) => {
        stubRect(el, 'container');
        containerRef(el);
      }}
    >
      <div
        ref={(el) => {
          stubRect(el, 'item');
          itemRef(el);
        }}
      />
      <span data-testid="count">{count}</span>
    </div>
  );
}

function setDesktop(matches: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as typeof window.matchMedia;
}

const count = () => Number(screen.getByTestId('count').textContent);

describe('useFitCount', () => {
  const originalRO = globalThis.ResizeObserver;
  const originalMM = window.matchMedia;

  beforeEach(() => {
    observers = [];
    sizes.container = 300;
    sizes.item = 40;
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    setDesktop(true);
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalRO;
    window.matchMedia = originalMM;
  });

  it('fits as many items as the container holds', () => {
    render(<Probe />);
    // (300 + 8) / (40 + 8) = 6.4 → 6
    expect(count()).toBe(6);
  });

  it('clamps to min and max', () => {
    sizes.container = 60;
    const { unmount } = render(<Probe />);
    expect(count()).toBe(3);
    unmount();
    sizes.container = 2000;
    render(<Probe />);
    expect(count()).toBe(10);
  });

  it('recomputes when the container resizes', () => {
    render(<Probe />);
    expect(count()).toBe(6);
    sizes.container = 150;
    act(() => observers.forEach((fire) => fire()));
    // (150 + 8) / 48 = 3.29 → 3
    expect(count()).toBe(3);
  });

  it('returns the fallback without ResizeObserver', () => {
    // @ts-expect-error simulating jsdom without ResizeObserver
    globalThis.ResizeObserver = undefined;
    render(<Probe />);
    expect(count()).toBe(5);
  });

  it('returns the fallback below the lg breakpoint', () => {
    setDesktop(false);
    render(<Probe />);
    expect(count()).toBe(5);
  });
});
