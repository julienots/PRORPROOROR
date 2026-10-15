/** Bus d'évènements typé, découplant simulation, rendu, interface et audio. */
export type Handler<T> = (payload: T) => void;

export class EventBus<M extends Record<string, unknown>> {
  private handlers = new Map<keyof M, Set<Handler<never>>>();

  on<K extends keyof M>(type: K, fn: Handler<M[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn as Handler<never>);
    return () => set!.delete(fn as Handler<never>);
  }

  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as Handler<M[K]>)(payload);
      } catch (e) {
        console.error(`[EventBus] handler error on "${String(type)}"`, e);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
