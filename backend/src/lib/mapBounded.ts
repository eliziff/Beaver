/**
 * Maps with a fixed number of workers: results land in input order and the
 * first rejection wins, exactly as `Promise.all` over the whole input would.
 */
export async function mapBounded<T, R>(input: readonly T[],
  operation: (value: T, index: number) => Promise<R>, workers = 4) {
  const output = new Array<R>(input.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, input.length) }, async () => {
    while (next < input.length) {
      const index = next++;
      output[index] = await operation(input[index], index);
    }
  }));
  return output;
}
