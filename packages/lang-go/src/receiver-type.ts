/**
 * The receiver type name a method ID uses, from the receiver's type text: the pointer star and the type
 * parameters are dropped (`*List[T]` and `Pair[K, V]` give `List` and `Pair`), so syntax-tier method IDs match
 * the ones ctxo-go-analyzer emits.
 */
export function receiverTypeName(typeText: string): string {
  const name = typeText.trim().replace(/^\*\s*/, '');
  const bracket = name.indexOf('[');
  return (bracket < 0 ? name : name.slice(0, bracket)).trim();
}
