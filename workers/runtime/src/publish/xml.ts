/** Determine whether a value is one of the four XML Schema boolean lexical forms. */
export function isXmlBoolean(value: string | null | undefined): boolean {
  return value === "true" || value === "false" || value === "1" || value === "0";
}
