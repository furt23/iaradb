import type { IaraAgent, IaraEvent, IaraMessage, IaraOutcome, IaraStep, IaraSurface, IaraThreadView, IaraUsage } from "@/lib/iara/protocol";

/** What the panel shows of the conversation. A thread whose id is "" is new: the server names it in its first event. */
export interface ChatState {
  thread: IaraThreadView | null;
  /** who works now */
  agent: IaraAgent | null;
  error: string | null;
}

export const emptyChat: ChatState = { thread: null, agent: null, error: null };

const NO_USAGE: IaraUsage = { context: 0, budget: 0, turnInput: 0, turnOutput: 0 };

/** The user's message and the empty Iara message the answer streams into. */
export function beginTurn(state: ChatState, turn: { fileId: string; surface: IaraSurface; text: string; at: number }): ChatState {
  const { fileId, surface, text, at } = turn;
  const thread = state.thread ?? { id: "", fileId, surface, title: "", updated: at, messages: [], pending: null, usage: NO_USAGE };
  const messages: IaraMessage[] = [...thread.messages, { id: `u${at}`, role: "user", text, at }, { id: `i${at}`, role: "iara", text: "", at }];
  return { thread: { ...thread, messages }, agent: null, error: null };
}

/** The user's answer to the pending proposal; Iara's next events continue the same message. */
export function recordDecision(state: ChatState, proposalId: string, decision: "approved" | "rejected", outcome?: IaraOutcome): ChatState {
  const { thread } = state;
  if (!thread) return state;
  const messages = thread.messages.map((m) =>
    m.proposals?.some((p) => p.id === proposalId) ? { ...m, proposals: m.proposals.map((p) => (p.id === proposalId ? { ...p, decision, outcome } : p)) } : m,
  );
  return { ...state, thread: { ...thread, messages, pending: null } };
}

/** Changes Iara's last message, the one the stream is writing. */
function patchLast(state: ChatState, patch: (m: IaraMessage) => IaraMessage): ChatState {
  const { thread } = state;
  const last = thread?.messages.at(-1);
  if (!thread || !last || last.role !== "iara") return state;
  return { ...state, thread: { ...thread, messages: [...thread.messages.slice(0, -1), patch(last)] } };
}

/** A thought delta extends the last step when it is the same thought (its id); otherwise it starts a new one. */
function addThought(steps: IaraStep[], { agent, id, delta }: { agent: IaraAgent; id: string; delta: string }): IaraStep[] {
  const last = steps.at(-1);
  if (last?.kind === "thought" && last.id === id) return [...steps.slice(0, -1), { ...last, text: last.text + delta }];
  return [...steps, { kind: "thought", agent, id, text: delta }];
}

/** Folds one server event into the state. */
export function reduceEvent(state: ChatState, event: IaraEvent): ChatState {
  switch (event.event) {
    case "thread":
      return state.thread ? { ...state, thread: { ...state.thread, id: event.data.id, title: event.data.title } } : state;
    case "agent":
      return { ...state, agent: event.data.agent };
    case "text":
      return patchLast(state, (m) => ({ ...m, text: m.text + event.data.delta }));
    case "tool":
      return patchLast(state, (m) => ({ ...m, steps: [...(m.steps ?? []), { kind: "tool", ...event.data }] }));
    case "thought":
      return patchLast(state, (m) => ({ ...m, steps: addThought(m.steps ?? [], event.data) }));
    case "memory":
      return patchLast(state, (m) => ({ ...m, memories: [...(m.memories ?? []), event.data] }));
    case "chart":
      return patchLast(state, (m) => ({ ...m, charts: [...(m.charts ?? []), event.data] }));
    case "usage":
      return state.thread ? { ...state, thread: { ...state.thread, usage: event.data } } : state;
    case "approval": {
      const next = patchLast(state, (m) => ({ ...m, proposals: [...(m.proposals ?? []), { ...event.data, decision: "pending" }] }));
      return next.thread ? { ...next, thread: { ...next.thread, pending: event.data } } : next;
    }
    case "done":
      return { ...state, agent: null };
    case "failed":
      return { ...state, agent: null, error: event.data.message };
  }
}
