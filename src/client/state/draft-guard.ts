/** Browser unload protection owned by the plugin, independent of sidebar mounting. */
export class DraftGuard {
  private readonly dirty = new Set<string>()
  private readonly warn = (event: BeforeUnloadEvent): void => {
    event.preventDefault()
    event.returnValue = ''
  }
  /** @param target - Browser window providing the native unload confirmation. */
  constructor(private readonly target: Window) {}
  /** @param key - Session and pane/workspace identity. @param dirty - Whether an unsaved draft remains. */
  update(key: string, dirty: boolean): void {
    const wasDirty = this.dirty.size > 0
    if (dirty) this.dirty.add(key)
    else this.dirty.delete(key)
    if (!wasDirty && this.dirty.size) this.target.addEventListener('beforeunload', this.warn)
    if (wasDirty && !this.dirty.size) this.target.removeEventListener('beforeunload', this.warn)
  }
  /** Remove the listener when the owning plugin unloads. */
  dispose(): void { this.target.removeEventListener('beforeunload', this.warn); this.dirty.clear() }
}
