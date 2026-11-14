import "server-only";

import type { IaraChart, IaraToolUse } from "@/lib/iara/protocol";

type Send = (event: string, data: unknown) => void;

export interface Answered {
  /** the agent's message */
  messageId: string;
  threadId: string;
  answer: string;
  queries: string[];
  ms: number;
  charts: IaraChart[];
}

/** Wraps a turn's `send`: passes every event on, and once the turn is done gives `onDone` the reply, the SQL the agents ran and how long it took. A failed turn is not recorded. */
export function recordingSend(send: Send, onDone: (a: Answered) => void, now = Date.now): Send {
  const started = now();
  let threadId = "";
  let answer = "";
  const queries: string[] = [];
  const charts: IaraChart[] = [];
  return (event, data) => {
    if (event === "chart") charts.push(data as IaraChart);
    if (event === "thread") threadId = (data as { id: string }).id;
    else if (event === "text") answer += (data as { delta: string }).delta;
    else if (event === "tool") {
      const sql = (data as IaraToolUse).sql;
      if (sql) queries.push(sql);
    } else if (event === "done") onDone({ messageId: (data as { messageId: string }).messageId, threadId, answer, queries, ms: now() - started, charts });
    send(event, data);
  };
}
