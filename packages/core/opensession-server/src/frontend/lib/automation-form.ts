/** .automation-form label */
export const FIELD_LABEL =
  "flex flex-1 flex-col gap-1.5 text-label font-medium text-dim";

/** .automation-form-row */
export const FORM_ROW = "flex gap-3.5 phone:flex-col";

export function uniqueFlowId(prefix: string, used: string[]): string {
  let candidate = prefix;
  let index = 2;
  while (used.includes(candidate)) candidate = `${prefix}-${index++}`;
  return candidate;
}
