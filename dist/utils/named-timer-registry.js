export class NamedTimerRegistry {
    timers = new Map();
    schedule(name, delayMs, task) {
        this.cancel(name);
        let timer;
        timer = setTimeout(() => {
            if (this.timers.get(name) !== timer)
                return;
            this.timers.delete(name);
            void Promise.resolve().then(task).catch(() => { });
        }, Math.max(0, delayMs));
        timer.unref?.();
        this.timers.set(name, timer);
    }
    cancel(name) {
        const timer = this.timers.get(name);
        if (!timer)
            return false;
        clearTimeout(timer);
        this.timers.delete(name);
        return true;
    }
    cancelAll() {
        for (const timer of this.timers.values())
            clearTimeout(timer);
        this.timers.clear();
    }
    has(name) {
        return this.timers.has(name);
    }
}
