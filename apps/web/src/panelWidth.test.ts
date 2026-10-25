import { describe, expect, it } from 'vitest';
import { clampPanel, panelDefault, panelMax, panelWide, PANEL_MIN, togglePanel } from './panelWidth.js';

describe('panel width', () => {
  it('clamps to 320px .. 75% of the window', () => {
    expect(clampPanel(10, 1600)).toBe(PANEL_MIN);
    expect(clampPanel(5000, 1600)).toBe(1200);
    expect(panelMax(1600)).toBe(1200);
    expect(clampPanel(500, 1600)).toBe(500);
    expect(panelMax(300)).toBe(PANEL_MIN);
  });
  it('double-click toggles default <-> ~60% wide', () => {
    expect(panelWide(1600)).toBe(960);
    expect(togglePanel(panelDefault(1600), 1600)).toBe(960);
    expect(togglePanel(960, 1600)).toBe(panelDefault(1600));
  });
});
