export function oneAtATime(): <T>(run: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
