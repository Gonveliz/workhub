/**
 * A piece of app state kept between launches (open sessions, watcher memory, spend ledgers).
 * The main process stores it in the data folder's database; services only see this shape.
 */
export interface StateStore<T> {
  /** The stored value merged over `fallback`; `fallback` when nothing (usable) is stored. */
  load(fallback: T): T
  /** Keeps `value` and writes it soon (implementations may debounce). */
  save(value: T): void
  /** Writes what is pending now. Never throws. */
  flush(): void
}
