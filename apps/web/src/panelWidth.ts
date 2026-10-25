// Width of the right-hand panel: clamping rules, defaults and persistence (pure, unit-tested).
export const PANEL_MIN = 320;
export const PANEL_KEY = 'lens:panel-width';
export const PANEL_STEP = 32;

export const panelMax = (win: number) => Math.max(PANEL_MIN, Math.floor(win * 0.75));
export const panelDefault = (win: number) => clampPanel(win * 0.3, win);
export const panelWide = (win: number) => clampPanel(win * 0.6, win);
export const clampPanel = (w: number, win: number) => Math.round(Math.min(panelMax(win), Math.max(PANEL_MIN, w)));
/** Double-click: default -> wide -> default. */
export const togglePanel = (w: number, win: number) => (w >= panelWide(win) - 2 ? panelDefault(win) : panelWide(win));

export function loadPanelWidth(): number | null {
  try { const n = Number(localStorage.getItem(PANEL_KEY)); return Number.isFinite(n) && n > 0 ? n : null; } catch { return null; }
}
export function savePanelWidth(w: number) {
  try { localStorage.setItem(PANEL_KEY, String(Math.round(w))); } catch { /* storage unavailable */ }
}
