import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { FitList } from '../FitList';

// jsdom does no layout: model it. Each item's height comes from data-h on its
// content; items stack with GAP between them inside a container of CONTAINER_H.
const GAP = 8;
let CONTAINER_H = 220;

const isItem = (el: HTMLElement) => el.parentElement?.dataset.fitContainer !== undefined;
const heightOf = (el: HTMLElement) => Number((el.firstElementChild as HTMLElement | null)?.dataset.h ?? 0);

const props = {
  offsetHeight: {
    get(this: HTMLElement) {
      return isItem(this) ? heightOf(this) : 0;
    },
  },
  offsetTop: {
    get(this: HTMLElement) {
      if (!isItem(this)) return 0;
      let top = 0;
      let prev = this.previousElementSibling as HTMLElement | null;
      while (prev) {
        top += heightOf(prev) + GAP;
        prev = prev.previousElementSibling as HTMLElement | null;
      }
      return top;
    },
  },
  clientHeight: {
    get(this: HTMLElement) {
      return this.dataset.fitContainer !== undefined ? CONTAINER_H : 0;
    },
  },
};

const saved: Record<string, PropertyDescriptor | undefined> = {};
const originalRO = globalThis.ResizeObserver;
const originalMM = window.matchMedia;

function setDesktop(matches: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as typeof window.matchMedia;
}

function List({ heights, min = 1, max = 10, fallback = 4 }: { heights: number[]; min?: number; max?: number; fallback?: number }) {
  return (
    <FitList items={heights.map((h, i) => ({ h, i }))} min={min} max={max} fallback={fallback} gap={GAP} getKey={(it) => String(it.i)}>
      {(it) => <span data-h={it.h}>item {it.i}</span>}
    </FitList>
  );
}

const items = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[data-fit-container] > div')];
const visible = (c: HTMLElement) => items(c).filter((el) => el.style.visibility !== 'hidden');

describe('FitList', () => {
  beforeEach(() => {
    CONTAINER_H = 220;
    for (const [key, descriptor] of Object.entries(props)) {
      saved[key] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
      Object.defineProperty(HTMLElement.prototype, key, { configurable: true, ...descriptor });
    }
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    setDesktop(true);
  });

  afterEach(() => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    }
    globalThis.ResizeObserver = originalRO;
    window.matchMedia = originalMM;
  });

  it('shows only whole items when they differ in height (no half-clipped last row)', () => {
    // 0–40, 48–128, 136–216 fit in 220; the 4th (224–304) does not
    const { container } = render(<List heights={[40, 80, 80, 80, 80]} />);
    expect(visible(container)).toHaveLength(3);
  });

  it('fills the room when the first item is the tallest', () => {
    // 0–100, 108–138, 146–176, 184–214 fit; 222–252 does not
    const { container } = render(<List heights={[100, 30, 30, 30, 30, 30]} />);
    expect(visible(container)).toHaveLength(4);
  });

  it('reserves a floor tall enough for the first `min` items', () => {
    const { container } = render(<List heights={[40, 80, 80, 80]} min={3} />);
    const wrapper = container.firstElementChild as HTMLElement;
    // bottom of item 3 = 136 + 80
    expect(wrapper.style.getPropertyValue('--fit-min')).toBe('216px');
  });

  it('never shows fewer than min, and at most max', () => {
    CONTAINER_H = 50;
    const { container, unmount } = render(<List heights={[40, 40, 40, 40]} min={3} />);
    expect(visible(container)).toHaveLength(3);
    unmount();
    CONTAINER_H = 5000;
    const r = render(<List heights={Array(15).fill(30)} max={12} />);
    expect(visible(r.container)).toHaveLength(12);
  });

  it('renders the fallback count, in flow, without ResizeObserver', () => {
    // @ts-expect-error simulating jsdom without ResizeObserver
    globalThis.ResizeObserver = undefined;
    const { container } = render(<List heights={Array(10).fill(40)} fallback={4} />);
    expect(items(container)).toHaveLength(4);
    expect(visible(container)).toHaveLength(4);
  });

  it('renders the fallback count below the lg breakpoint', () => {
    setDesktop(false);
    const { container } = render(<List heights={Array(10).fill(40)} fallback={4} />);
    expect(items(container)).toHaveLength(4);
  });
});
