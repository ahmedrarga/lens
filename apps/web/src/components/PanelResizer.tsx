import { useCallback, useEffect, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { clampPanel, loadPanelWidth, panelDefault, panelMax, PANEL_MIN, PANEL_STEP, savePanelWidth, togglePanel } from '../panelWidth.js';

/** Width state + a drag handle for the right-hand panel. Apply `width` to the grid column. */
export function useResizablePanel() {
  const [win, setWin] = useState(() => window.innerWidth);
  const [stored, setStored] = useState<number | null>(loadPanelWidth);
  useEffect(() => {
    const on = () => setWin(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const width = clampPanel(stored ?? panelDefault(win), win);
  const set = useCallback((w: number, persist = true) => {
    const c = clampPanel(w, window.innerWidth);
    setStored(c); if (persist) savePanelWidth(c);
  }, []);
  return { width, win, set };
}

export function PanelResizer({ width, win, set }: ReturnType<typeof useResizablePanel>) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const { userSelect, cursor } = document.body.style;
    document.body.style.userSelect = 'none'; document.body.style.cursor = 'col-resize';
    return () => { document.body.style.userSelect = userSelect; document.body.style.cursor = cursor; };
  }, [dragging]);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId); // all further events go here, not to the canvas or iframes
    e.preventDefault(); setDragging(true);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => { if (dragging) set(window.innerWidth - e.clientX, false); };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture(e.pointerId); setDragging(false); set(window.innerWidth - e.clientX);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === 'ArrowLeft' ? PANEL_STEP : e.key === 'ArrowRight' ? -PANEL_STEP : 0; // the handle is on the panel's left edge
    if (d) { e.preventDefault(); set(width + d); }
    else if (e.key === 'Enter') { e.preventDefault(); set(togglePanel(width, win)); }
  };
  return (
    <div
      className={`ws-resizer${dragging ? ' is-dragging' : ''}`} role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label="Resize side panel (double-click to toggle wide)" aria-valuenow={width} aria-valuemin={PANEL_MIN} aria-valuemax={panelMax(win)}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={() => setDragging(false)}
      onDoubleClick={() => set(togglePanel(width, win))} onKeyDown={key}
    />
  );
}
