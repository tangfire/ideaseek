/**
 * Pure interactive picker model for in-TUI selections (/models setup, /open,
 * /agent sessions, /pending approvals). Selection dispatches the exact same
 * slash/CLI commands as manual entry — zero separate business state (ADR-006).
 */

export interface PickerItem {
  id: string;
  label: string;
  detail: string;
  /** Command submitted into `session.submit` when picked (or prefill text). */
  command?: string;
  /** When set instead of `command`, pre-fills the composer line. */
  prefill?: string;
}

export interface PickerState {
  kind: 'provider' | 'project' | 'session' | 'pending';
  title: string;
  hint: string;
  items: PickerItem[];
  selected: number;
}

export function createPicker(
  kind: PickerState['kind'],
  title: string,
  items: PickerItem[],
  hint = '↑/↓ select · Enter confirm · Esc close',
): PickerState | null {
  if (items.length === 0) return null;
  return { kind, title, hint, items, selected: 0 };
}

export function movePicker(state: PickerState, delta: number): PickerState {
  const n = state.items.length;
  if (n === 0) return state;
  const selected = (((state.selected + delta) % n) + n) % n;
  return { ...state, selected };
}

export function selectedPickerItem(state: PickerState): PickerItem | null {
  return state.items[state.selected] ?? null;
}
