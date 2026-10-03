import { reactive } from "vue";

export const toasts = reactive<{ id: number; msg: string; err: boolean }[]>([]);
let next = 1;

export function toast(msg: string, err = false): void {
  const id = next++;
  toasts.push({ id, msg, err });
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id);
    if (i >= 0) toasts.splice(i, 1);
  }, err ? 7000 : 3500);
}
