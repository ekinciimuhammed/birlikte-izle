// Tipli küçük olay yayıcı: on('peer', fn) → fn'in parametresi derleme anında bilinir.

type Handler<T> = (arg: T) => void;
type Args<T> = [T] extends [void] ? [] : [T];

export class Emitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(type: K, fn: Handler<Events[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn as Handler<never>);
    return () => set.delete(fn as Handler<never>);
  }

  protected emit<K extends keyof Events>(type: K, ...args: Args<Events[K]>) {
    for (const fn of this.handlers.get(type) ?? []) (fn as (...a: unknown[]) => void)(...args);
  }
}
