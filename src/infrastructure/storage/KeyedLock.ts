/** Runs async tasks one at a time per key, in the order they were asked for. The server is one process, so this is the whole concurrency story */
export class KeyedLock {
    private readonly tails = new Map<string, Promise<unknown>>();

    async run<T>(key: string, task: () => Promise<T>): Promise<T> {
        const previous = this.tails.get(key) ?? Promise.resolve();
        const result = previous.then(task, task);
        const tail = result.catch(() => undefined);
        this.tails.set(key, tail);
        try {
            return await result;
        } finally {
            if (this.tails.get(key) === tail) this.tails.delete(key);
        }
    }
}
