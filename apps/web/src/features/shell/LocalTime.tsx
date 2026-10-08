"use client";

import { useEffect, useState } from "react";

/**
 * A timestamp in the viewer's locale and time zone. The server renders a
 * fixed UTC form first (it knows neither), so hydration never mismatches.
 */
export function LocalTime({ ms }: { ms: number }) {
  const [text, setText] = useState(() => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC");
  useEffect(() => setText(new Date(ms).toLocaleString()), [ms]);
  return <time dateTime={new Date(ms).toISOString()}>{text}</time>;
}
