/** `model_layout.json`: where each table sits on the model's diagram, in pixels (pure). */

export type ModelLayout = Record<string, { x: number; y: number }>;

const MAX_PLACE = 100_000;

const place = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_PLACE;

/** The places of a value of any kind (the parsed file, or an action's input). */
export function checkModelLayout(value: unknown): ModelLayout {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("the model's layout is an object");
  // fromEntries, not an assignment: a dataset named __proto__ must stay a key
  return Object.fromEntries(
    Object.entries(value).map(([name, at]: [string, unknown]) => {
      const { x, y } = (at ?? {}) as { x?: unknown; y?: unknown };
      if (!place(x) || !place(y)) throw new Error(`the place of ${name} is x and y, from 0`);
      return [name, { x: Math.round(x as number), y: Math.round(y as number) }];
    }),
  );
}

export function parseModelLayout(json: string): ModelLayout {
  return checkModelLayout(JSON.parse(json));
}
