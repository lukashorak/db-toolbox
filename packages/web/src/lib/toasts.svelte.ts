export interface Toast {
  id: number;
  tone: 'info' | 'success' | 'warning' | 'danger';
  message: string;
}

export const toasts = $state<Toast[]>([]);
let next = 1;

/** Announces a short message in the live region; it disappears after a while. */
export function toast(message: string, tone: Toast['tone'] = 'info', ms = 5000): void {
  const id = next++;
  toasts.push({ id, tone, message });
  setTimeout(() => dismiss(id), ms);
}

export function dismiss(id: number): void {
  const at = toasts.findIndex((t) => t.id === id);
  if (at !== -1) toasts.splice(at, 1);
}
