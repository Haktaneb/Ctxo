/** A rough token count: a quarter of the JSON length, rounded up. A value JSON cannot hold counts 0. */
export function estimateTokens(value: unknown): number {
  const json: string | undefined = JSON.stringify(value);
  return json === undefined ? 0 : Math.ceil(json.length / 4);
}
