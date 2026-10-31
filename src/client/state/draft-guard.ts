/** Browser unload protection owned by the plugin, independent of sidebar mounting. */
export class DraftGuard {
  private readonly dirty = new Map<string, () => void>()
  private readonly warn = (event: BeforeUnloadEvent): void => {
    event.preventDefault()
    event.returnValue = ''
  }
  /** @param target - Browser window providing the native unload confirmation. */
  constructor(private readonly target: Window) {}
  /** @param key - Session and tab/workspace identity. @param dirty - Whether an unsaved draft remains. @param signal - Tab lifetime, independent of visibility or component mounting. */
  update(key: string, dirty: boolean, signal: AbortSignal): void {
    const wasDirty = this.dirty.size > 0
    this.dirty.get(key)?.()
    this.dirty.delete(key)
    if (dirty && !signal.aborted) {
      const forget = () => this.update(key, false, signal)
      signal.addEventListener('abort', forget, { once: true })
      this.dirty.set(key, () => signal.removeEventListener('abort', forget))
    }
    if (!wasDirty && this.dirty.size) this.target.addEventListener('beforeunload', this.warn)
    if (wasDirty && !this.dirty.size) this.target.removeEventListener('beforeunload', this.warn)
  }
  /** Remove the listener when the owning plugin unloads. */
  dispose(): void {
    this.target.removeEventListener('beforeunload', this.warn)
    for (const release of this.dirty.values()) release()
    this.dirty.clear()
  }
}
