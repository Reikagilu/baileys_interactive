export class NamedTimerRegistry {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  schedule(name: string, delayMs: number, task: () => unknown | Promise<unknown>): void {
    this.cancel(name);
    let timer: NodeJS.Timeout;
    timer = setTimeout(() => {
      if (this.timers.get(name) !== timer) return;
      this.timers.delete(name);
      void Promise.resolve().then(task).catch(() => {});
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.timers.set(name, timer);
  }

  cancel(name: string): boolean {
    const timer = this.timers.get(name);
    if (!timer) return false;
    clearTimeout(timer);
    this.timers.delete(name);
    return true;
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  has(name: string): boolean {
    return this.timers.has(name);
  }
}
