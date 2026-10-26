"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMemo, useState } from "react";

import { CodeEditor } from "@/features/editor/CodeEditor";
import { useTranslation } from "@/i18n";
import { MAX_MESSAGE, type IaraFileContext, type IaraProposal } from "@/lib/iara/protocol";

import { changeDiff, changeLanguage, changeTitle } from "./labels";

/** A change Iara proposes, waiting for the user: what it does, its code, and Keep and run / Keep / Reject. */
export function ApprovalCard({
  proposal,
  busy,
  canRun,
  getContext,
  onApprove,
  onReject,
}: {
  proposal: IaraProposal;
  busy: boolean;
  /** false: the file cannot run cells now, so only "Keep" is offered */
  canRun: boolean;
  getContext: () => IaraFileContext;
  /** run: false is "Keep" */
  onApprove(run: boolean): void;
  onReject(feedback?: string): void;
}) {
  const { t } = useTranslation();
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const { change } = proposal;
  const title = changeTitle(change);
  // the code and its language are read once, not on every streamed render; stale when the edits no longer fit the code
  const { diff, language, stale } = useMemo(() => {
    const context = getContext();
    const language = changeLanguage(change, context);
    try {
      return { diff: changeDiff(change, context), language, stale: false };
    } catch {
      return { diff: null, language, stale: true };
    }
  }, [change]);

  return (
    <Paper variant="outlined" sx={{ p: 1.5, display: "flex", flexDirection: "column", gap: 1.25 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Typography sx={{ fontWeight: 650, fontSize: 13.5 }}>{t(title.key, title.values)}</Typography>
        {proposal.attempt > 1 && <Chip size="small" color="warning" variant="outlined" label={t("Fix {{attempt}}", { attempt: proposal.attempt })} />}
      </Box>
      <Typography variant="body2">{proposal.explanation}</Typography>
      {diff && (
        <Paper variant="outlined" sx={{ overflow: "hidden" }}>
          <CodeEditor value={diff.after} original={diff.before ?? undefined} language={language} readOnly maxHeight={260} />
        </Paper>
      )}
      {stale && (
        <Alert severity="warning" sx={{ py: 0 }}>
          {t("The code changed since Iara read it. Reject the change and ask again.")}
        </Alert>
      )}
      {proposal.review && (
        <Alert severity="warning" sx={{ py: 0 }}>
          {proposal.review}
        </Alert>
      )}
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
        {change.action === "run_cell" ? (
          canRun && (
            <Button variant="contained" color="secondary" disabled={busy} onClick={() => onApprove(true)}>
              {t("Run")}
            </Button>
          )
        ) : (
          !stale && (
            <>
              {canRun && (
                <Button variant="contained" color="secondary" disabled={busy} onClick={() => onApprove(true)}>
                  {t("Keep and run")}
                </Button>
              )}
              <Button disabled={busy} onClick={() => onApprove(false)}>
                {t("Keep")}
              </Button>
            </>
          )
        )}
        <Button color="inherit" disabled={busy} onClick={() => setRejecting((open) => !open)}>
          {t("Reject")}
        </Button>
      </Box>
      {rejecting && (
        <Box sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
          <TextField
            autoFocus
            multiline
            fullWidth
            size="small"
            label={t("What should change? (optional)")}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            disabled={busy}
            slotProps={{ htmlInput: { maxLength: MAX_MESSAGE } }}
          />
          <Button disabled={busy} onClick={() => onReject(feedback)}>
            {t("Send")}
          </Button>
        </Box>
      )}
    </Paper>
  );
}
