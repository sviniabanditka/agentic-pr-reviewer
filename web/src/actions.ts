import { api } from "./api";
import { store } from "./store";
import { toast } from "./components/toast";
import { short } from "./format";

export async function startReview(itemId: string, model?: string, profileId?: string): Promise<number | null> {
  const item = store.items.get(itemId);
  const profile = store.profiles.find((p) => p.id === profileId);
  try {
    const { id } = await api.post<{ id: number }>("/reviews", { itemId, ...(model ? { model } : {}), ...(profileId ? { profileId } : {}) });
    toast(`reviewing ${item ? `${short(item.repo)} #${item.number}` : "pull request"}${profile ? `: ${profile.name.toLowerCase()}` : ""}${model ? ` with ${model}` : ""}`);
    return id;
  } catch (e) {
    toast(`could not start the review: ${(e as Error).message}`, true);
    return null;
  }
}

export async function publishReview(id: number): Promise<boolean> {
  const r = store.reviews.get(id);
  try {
    const { url } = await api.post<{ url: string }>(`/reviews/${id}/publish`);
    toast(`posted to ${r ? `${short(r.repo)} #${r.number}` : "the pull request"}`);
    void url;
    return true;
  } catch (e) {
    toast(`could not post: ${(e as Error).message}`, true);
    return false;
  }
}

export async function cancelReview(id: number): Promise<void> {
  try {
    await api.post(`/reviews/${id}/cancel`);
    toast("review cancelled");
  } catch (e) {
    toast((e as Error).message, true);
  }
}

/** The model a picker preselects for an item: last choice, else the account default. */
export function preferredModel(itemId: string, accountModel: string | null | undefined): string {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(`model:${itemId}`);
  } catch {}
  return saved && store.models.includes(saved) ? saved : accountModel && store.models.includes(accountModel) ? accountModel : store.models[0] ?? "sonnet";
}

export function rememberModel(itemId: string, model: string): void {
  try {
    localStorage.setItem(`model:${itemId}`, model);
  } catch {}
}

/** The profile a picker preselects: last choice for the item, else the account's, else the default. */
export function preferredProfile(itemId: string, accountProfileId: string | null | undefined): string {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(`profile:${itemId}`);
  } catch {}
  const ids = store.profiles.map((p) => p.id);
  if (saved && ids.includes(saved)) return saved;
  if (accountProfileId && ids.includes(accountProfileId)) return accountProfileId;
  return store.profiles.find((p) => p.isDefault)?.id ?? ids[0] ?? "";
}

export function rememberProfile(itemId: string, profileId: string): void {
  try {
    localStorage.setItem(`profile:${itemId}`, profileId);
  } catch {}
}
