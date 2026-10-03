export type EventType = "log" | "job" | "status" | "prs" | "stage" | "hello";
export interface LiveEvent {
  type: EventType;
  data: unknown;
  /** Delivered only to this user's streams; absent = everyone. */
  userId?: string;
}
type Listener = (event: LiveEvent) => void;

/** In-process pub/sub feeding the SSE streams. */
export class Bus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: LiveEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
