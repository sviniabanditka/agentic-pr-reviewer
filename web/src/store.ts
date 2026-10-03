import { reactive } from "vue";
import { api } from "./api";
import type { Account, Credential, Item, LogEvent, Mode, ModelInfo, Profile, Review, Stage, Target, Totals, User } from "./types";

export const store = reactive({
  user: null as User | null,
  ready: false,
  live: false,
  startedAt: 0,
  models: [] as string[],
  providers: [] as string[],
  accounts: [] as Account[],
  credentials: [] as Credential[],
  targets: [] as Target[],
  profiles: [] as Profile[],
  modes: [] as Mode[],
  categoryText: {} as Record<string, string>,
  catalog: [] as ModelInfo[],
  items: new Map<string, Item>(),
  reviews: new Map<number, Review>(),
  stages: {} as Record<number, Stage>,
  events: [] as LogEvent[],
  totals: null as Totals | null,
  now: Date.now(),
});

// One ticker for every relative time and timer on the page.
setInterval(() => (store.now = Date.now()), 1000);

interface StateResponse {
  user: User; startedAt: number; models: string[]; providers: string[]; accounts: Account[]; credentials: Credential[];
  targets: Target[]; stages: Record<number, Stage>; totals: Totals; profiles: Profile[]; modes: Mode[];
  categoryText: Record<string, string>; catalog: ModelInfo[];
}

export async function loadState(): Promise<void> {
  const [state, items, reviews, logs] = await Promise.all([
    api.get<StateResponse>("/state"),
    api.get<{ items: Item[] }>("/items?state=all"),
    api.get<{ reviews: Review[] }>("/reviews?limit=300"),
    api.get<{ events: LogEvent[] }>("/logs?limit=400"),
  ]);
  Object.assign(store, {
    user: state.user, startedAt: state.startedAt, models: state.models, providers: state.providers, accounts: state.accounts,
    credentials: state.credentials, targets: state.targets, stages: state.stages, totals: state.totals, profiles: state.profiles,
    modes: state.modes, categoryText: state.categoryText, catalog: state.catalog, ready: true,
  });
  store.items = new Map(items.items.map((i) => [i.id, i]));
  store.reviews = new Map(reviews.reviews.map((r) => [r.id, r]));
  store.events = logs.events;
}

export async function refreshState(): Promise<void> {
  const state = await api.get<StateResponse>("/state");
  Object.assign(store, { accounts: state.accounts, credentials: state.credentials, targets: state.targets, totals: state.totals, models: state.models, profiles: state.profiles });
}

type Listener = (r: Review, previous: Review | undefined) => void;
const reviewListeners = new Set<Listener>();
export function onReviewChange(fn: Listener): () => void {
  reviewListeners.add(fn);
  return () => reviewListeners.delete(fn);
}

let source: EventSource | null = null;

export function connect(): void {
  source?.close();
  source = new EventSource("/api/v1/events");
  source.onopen = () => (store.live = true);
  source.onerror = () => (store.live = false);
  source.addEventListener("hello", (m) => {
    const { startedAt } = JSON.parse((m as MessageEvent).data) as { startedAt: number };
    // Reconnected to a restarted server, or first connect: take a fresh snapshot.
    if (startedAt !== store.startedAt || !store.ready) void loadState();
  });
  source.addEventListener("log", (m) => {
    store.events.push(JSON.parse((m as MessageEvent).data) as LogEvent);
    if (store.events.length > 3000) store.events.splice(0, 1000);
  });
  source.addEventListener("job", (m) => {
    const r = JSON.parse((m as MessageEvent).data) as Review;
    const previous = store.reviews.get(r.id);
    store.reviews.set(r.id, r);
    if (r.item_id) {
      const item = store.items.get(r.item_id);
      if (item && (!item.lastReview || item.lastReview.id <= r.id)) item.lastReview = r;
    }
    reviewListeners.forEach((fn) => fn(r, previous));
    if (previous?.status !== r.status && (r.status === "done" || r.status === "error")) void refreshState();
  });
  source.addEventListener("stage", (m) => {
    const { jobId, stage } = JSON.parse((m as MessageEvent).data) as { jobId: number; stage: Stage | null };
    if (stage) store.stages[jobId] = stage;
    else delete store.stages[jobId];
  });
  source.addEventListener("prs", (m) => {
    const { item } = JSON.parse((m as MessageEvent).data) as { item: Record<string, unknown> & { id: string } };
    const prev = store.items.get(item.id);
    store.items.set(item.id, toItem(item, prev?.lastReview ?? null));
  });
  source.addEventListener("status", (m) => {
    const data = JSON.parse((m as MessageEvent).data) as { credential?: Credential; target?: Record<string, unknown> };
    if (data.credential) {
      const i = store.credentials.findIndex((c) => c.id === data.credential!.id);
      if (i >= 0) store.credentials[i] = data.credential;
    }
    if (data.target) void refreshState();
  });
}

export function disconnect(): void {
  source?.close();
  source = null;
  store.live = false;
}

/** Items arrive over SSE as raw rows; the REST API sends views. Both end up as Item. */
function toItem(row: Record<string, unknown>, lastReview: Review | null): Item {
  if ("accountId" in row) return { ...(row as unknown as Item), lastReview };
  const r = row as Record<string, string & number>;
  return {
    id: r.id, accountId: r.account_id, kind: (r.kind || "pr") as Item["kind"], compareBase: r.compare_base, compareHead: r.compare_head, repo: r.repo, number: r.number, title: r.title, url: r.url, author: r.author,
    authorIsBot: r.author_is_bot === 1, role: r.role, headSha: r.head_sha, state: r.state, draft: r.draft === 1,
    labels: JSON.parse(r.labels_json || "[]"), additions: r.additions, deletions: r.deletions, changedFiles: r.changed_files,
    updatedAt: r.updated_at, targetIds: JSON.parse(r.target_ids_json || "[]"), firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, lastReview,
  };
}

export function accountOf(id: string | null | undefined): Account | undefined {
  return store.accounts.find((a) => a.id === id);
}
