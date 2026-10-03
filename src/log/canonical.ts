/**
 * 稳定序列化：对象键排序，数组保持顺序，跳过值为 undefined 的键。
 * 不这样做，同样的内容换个键顺序就会算出不同的哈希，链就假断了。
 *
 * 单独成文件、不引入 node:crypto，浏览器端签结论时用的是同一份。
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") +
    "}"
  );
}
