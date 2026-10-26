"use client";

import { useEffect, useRef, useState } from "react";

import { useTranslation } from "@/i18n";
import type { IaraEvent, IaraFileContext, IaraOutcome, IaraRequest, IaraSurface } from "@/lib/iara/protocol";
import { streamEvents } from "@/lib/sse";
import { listIaraThreadsAction, readIaraThreadAction } from "@/server/actions/iara";

import { beginTurn, emptyChat, recordDecision, reduceEvent, type ChatState } from "./chatState";
import type { IaraAdapter } from "./types";

export type IaraChat = ReturnType<typeof useIaraChat>;

/**
 * The conversation with Iara about one file: loads the file's newest thread,
 * streams each answer into it and answers the proposals Iara waits on.
 * `getContext` is called at every send and decision (after a change is applied,
 * too), so it must read the file's current state, e.g. from a ref.
 */
export function useIaraChat({
  fileId,
  surface,
  getContext,
  adapter,
}: {
  fileId: string;
  surface: IaraSurface;
  getContext: () => IaraFileContext;
  adapter: IaraAdapter;
}) {
  const { t } = useTranslation();
  const [chat, setChat] = useState<ChatState>(emptyChat);
  // streaming or applying a change
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const live = useRef({ getContext, adapter });
  useEffect(() => {
    live.current = { getContext, adapter };
  });

  /** Drops the stream in flight, if any. */
  const cancel = () => {
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
    setChat((s) => ({ ...s, agent: null }));
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await listIaraThreadsAction(fileId);
      const newest = list.ok ? list.data[0] : undefined;
      if (!newest || cancelled) return;
      const read = await readIaraThreadAction(newest.id);
      // a conversation the user began meanwhile stays
      if (read.ok && !cancelled) setChat((s) => (s.thread ? s : { ...emptyChat, thread: read.data }));
    })();
    return () => {
      cancelled = true;
      abort.current?.abort();
      abort.current = null;
      setBusy(false);
      setChat(emptyChat);
    };
  }, [fileId]);

  /** Streams the server's answer to a request into the conversation. */
  const run = async (body: IaraRequest) => {
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    let ended = false;
    try {
      await streamEvents(
        "/api/iara",
        body,
        (e) => {
          const event = e as unknown as IaraEvent;
          if (event.event === "done" || event.event === "failed" || event.event === "approval") ended = true;
          setChat((s) => reduceEvent(s, event));
        },
        controller.signal,
      );
      if (!ended) setChat((s) => ({ ...s, error: t("The connection was interrupted. Try again.") }));
    } catch {
      if (!controller.signal.aborted) setChat((s) => ({ ...s, error: t("Something went wrong. Try again.") }));
    } finally {
      if (abort.current === controller) {
        abort.current = null;
        setBusy(false);
        setChat((s) => ({ ...s, agent: null }));
      }
    }
  };

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy || chat.thread?.pending) return;
    setChat((s) => beginTurn(s, { fileId, surface, text: message, at: Date.now() }));
    await run({ kind: "message", threadId: chat.thread?.id || null, fileId, text: message, context: live.current.getContext() });
  };

  /** Applies the pending change (and runs it, if asked), then tells Iara how it went. */
  const approve = async (runIt: boolean) => {
    const thread = chat.thread;
    const pending = thread?.pending;
    if (!thread || !pending || busy) return;
    setBusy(true);
    let outcome: IaraOutcome;
    try {
      outcome = await live.current.adapter.apply(pending.change, runIt);
    } catch (e) {
      outcome = { applied: false, ran: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 4000) };
    }
    setChat((s) => recordDecision(s, pending.id, "approved", outcome));
    await run({
      kind: "decision",
      threadId: thread.id,
      proposalId: pending.id,
      decision: { kind: "approve", run: runIt, outcome },
      context: live.current.getContext(),
    });
  };

  const reject = async (feedback?: string) => {
    const thread = chat.thread;
    const pending = thread?.pending;
    if (!thread || !pending || busy) return;
    setChat((s) => recordDecision(s, pending.id, "rejected"));
    await run({
      kind: "decision",
      threadId: thread.id,
      proposalId: pending.id,
      decision: { kind: "reject", feedback: feedback?.trim() || undefined },
      context: live.current.getContext(),
    });
  };

  // the pending change shows in the file as a diff, answered there too; it is taken away once answered or when the panel closes
  const pending = chat.thread?.pending ?? null;
  const answer = useRef({ approve, reject });
  answer.current = { approve, reject };
  useEffect(() => {
    if (!pending) return;
    return live.current.adapter.preview?.(pending.change, { keep: (run) => void answer.current.approve(run), undo: () => void answer.current.reject() });
  }, [pending]);

  const newThread = () => {
    cancel();
    setChat(emptyChat);
  };

  const openThread = async (id: string) => {
    cancel();
    const read = await readIaraThreadAction(id);
    setChat(read.ok ? { ...emptyChat, thread: read.data } : { ...emptyChat, error: t("Something went wrong. Try again.") });
  };

  // not while a change is being applied: that has no stream to drop, and its card must stay disabled
  const stop = () => {
    if (abort.current) cancel();
  };

  // the approval cards read it: an adapter that does not say is a file that can run
  return { thread: chat.thread, busy, agent: chat.agent, error: chat.error, canRun: adapter.canRun !== false, send, approve, reject, stop, newThread, openThread };
}
