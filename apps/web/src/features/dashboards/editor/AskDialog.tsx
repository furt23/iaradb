"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { CodeEditor } from "@/features/editor/CodeEditor";
import { useNotify } from "@/features/shell/notify";
import { MAX_QUESTION, type AskAnswer, type AskDecision, type AskProposal, type AskReply } from "@/lib/dashboards/ask";
import { answerAskAction, askAction } from "@/server/actions/ask";

import { WidgetBody } from "../canvas/WidgetBody";
import { WidgetFrame } from "../canvas/WidgetFrame";

/** The proposal: the tables it reads, its query, and the widget as it would draw from the unsaved dataset. */
function ProposalView({ proposal }: { proposal: AskProposal }) {
  const { t } = useTranslation();
  return (
    <Stack spacing={2}>
      <Typography>{proposal.explanation}</Typography>
      <Box>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {t("Tables")}
        </Typography>
        <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap", gap: 0.5, mt: 0.5 }}>
          {proposal.tables.map((name) => (
            <Chip key={name} size="small" variant="outlined" label={name} />
          ))}
        </Stack>
      </Box>
      <Box>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {t("Dataset")}: {proposal.dataset.name}
        </Typography>
        <CodeEditor value={proposal.dataset.sql} language="sql" readOnly maxHeight={240} />
      </Box>
      <Box>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {t("Preview")}
        </Typography>
        <Box sx={{ height: 300, mt: 0.5 }}>
          <WidgetFrame title={proposal.widget.title}>
            <WidgetBody widget={proposal.widget} data={proposal.preview} loading={false} />
          </WidgetFrame>
        </Box>
      </Box>
    </Stack>
  );
}

/**
 * The dialog's content, mounted while it is open: the question, the proposal
 * it gets back, and the user's decision on it. Leaving (Cancel, Escape, a
 * save) unmounts it, and its cleanup drops a proposal still waiting.
 */
function AskForm({ slug, onClose, onSaved }: { slug: string; onClose(): void; onSaved(): void }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const [question, setQuestion] = useState("");
  const [reply, setReply] = useState<AskReply | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [feedback, setFeedback] = useState("");
  // the thread of the proposal on screen: a decision answers it
  const thread = useRef<string | null>(null);
  // false once unmounted: a question answered after that has no dialog to show it
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (thread.current) void answerAskAction(thread.current, { kind: "cancel" });
    };
  }, []);

  /** Shows what Ask answered: a saved dataset and widget ends the dialog, a proposal waits for a decision, a message ends the Ask. */
  const show = (answer: AskAnswer) => {
    if ("saved" in answer) {
      thread.current = null;
      onSaved();
      notify(t("Added to the dashboard"), "success");
      return onClose();
    }
    thread.current = "thread" in answer ? answer.thread : null;
    setReply(answer);
    setChanging(false);
    setFeedback("");
  };

  const ask = async () => {
    setBusy(true);
    setError(null);
    const r = await askAction(slug, question.trim());
    setBusy(false);
    if (!mounted.current) {
      if (r.ok && "thread" in r.data) void answerAskAction(r.data.thread, { kind: "cancel" });
      return;
    }
    if (r.ok) show(r.data);
    else setError(r.error.message);
  };

  /** Sends the decision on the proposal on screen; a refusal keeps the proposal, so the user can try again. */
  const decide = async (decision: AskDecision) => {
    const id = thread.current;
    if (!id) return;
    setBusy(true);
    setError(null);
    const r = await answerAskAction(id, decision);
    setBusy(false);
    if (r.ok) show(r.data);
    else setError(r.error.message);
  };

  const proposal = reply && "proposal" in reply ? reply.proposal : null;
  const message = reply && "message" in reply ? reply.message : null;

  return (
    <>
      <DialogTitle>{t("Ask about your data")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          {error && <Alert severity="error">{error}</Alert>}
          {proposal ? (
            <>
              <ProposalView proposal={proposal} />
              {busy && <LinearProgress />}
              {changing && (
                <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
                  <TextField
                    autoFocus
                    multiline
                    minRows={2}
                    fullWidth
                    label={t("What should change?")}
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    disabled={busy}
                    slotProps={{ htmlInput: { maxLength: MAX_QUESTION } }}
                  />
                  <Button disabled={busy || feedback.trim() === ""} onClick={() => void decide({ kind: "change", feedback: feedback.trim() })} sx={{ mt: 1 }}>
                    {t("Send")}
                  </Button>
                </Stack>
              )}
            </>
          ) : (
            <>
              {message && !busy && <Alert severity="info">{message}</Alert>}
              <TextField
                autoFocus
                multiline
                minRows={2}
                fullWidth
                label={t("Question")}
                placeholder={t("Monthly revenue by region as a bar chart")}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                disabled={busy}
                slotProps={{ htmlInput: { maxLength: MAX_QUESTION } }}
              />
              {busy && (
                <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
                  <CircularProgress size={18} />
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    {t("Writing the query…")}
                  </Typography>
                </Stack>
              )}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("Cancel")}</Button>
        {proposal ? (
          <>
            {!changing && (
              <Button disabled={busy} onClick={() => setChanging(true)}>
                {t("Change…")}
              </Button>
            )}
            <Button variant="contained" color="secondary" disabled={busy} onClick={() => void decide({ kind: "approve" })}>
              {t("Add to dashboard")}
            </Button>
          </>
        ) : (
          <Button variant="contained" color="secondary" disabled={busy || question.trim() === ""} onClick={() => void ask()}>
            {t("Ask")}
          </Button>
        )}
      </DialogActions>
    </>
  );
}

/** Asks a question about the data. The user approves the proposal, asks for a change, or cancels; nothing is saved before approval. */
export function AskDialog({ open, slug, onClose, onSaved }: { open: boolean; slug: string; onClose(): void; onSaved(): void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <AskForm slug={slug} onClose={onClose} onSaved={onSaved} />
    </Dialog>
  );
}
