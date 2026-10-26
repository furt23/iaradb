"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { formatRelative } from "@/lib/format";
import { publishAction, unpublishAction, type PublishedInfo } from "@/server/actions/dashboards";

const PREFIX = "cannot publish: ";

/** The reasons of a refused publish, one by one (the server joins them with "; "). */
function reasons(message: string): string[] {
  return message.startsWith(PREFIX) ? message.slice(PREFIX.length).split("; ") : [message];
}

function PublishForm({ slug, published, onChange, onClose }: { slug: string; published: PublishedInfo | null; onChange(published: PublishedInfo | null): void; onClose(): void }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<"team" | "emails">(published?.share.kind ?? "team");
  const [emails, setEmails] = useState(published?.share.kind === "emails" ? published.share.emails.join("\n") : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = emails.split(/[\s,;]+/).filter(Boolean);
  const ready = !busy && (kind === "team" || list.length > 0);

  /** Run `act` (it returns why it failed): the reason stays in the dialog, success closes it. */
  const submit = async (act: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const message = await act();
    setBusy(false);
    if (message) setError(message);
    else onClose();
  };
  const publish = () =>
    submit(async () => {
      const r = await publishAction(slug, kind === "team" ? { kind } : { kind, emails: list });
      if (r.ok) onChange(r.data);
      return r.ok ? null : r.error.message;
    });
  const unpublish = () =>
    submit(async () => {
      const r = await unpublishAction(slug);
      if (r.ok) onChange(null);
      return r.ok ? null : r.error.message;
    });
  const why = error === null ? [] : reasons(error);

  return (
    <>
      <DialogTitle>{t("Publish dashboard")}</DialogTitle>
      <DialogContent>
        {published && (
          <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5 }}>
            {t("Published {{when}} by {{who}}.", { when: formatRelative(published.publishedAt), who: published.publishedBy })}
          </Typography>
        )}
        <FormControl fullWidth>
          <RadioGroup value={kind} onChange={(e) => setKind(e.target.value as "team" | "emails")} aria-label={t("Who can view it")}>
            <FormControlLabel value="team" control={<Radio />} label={t("Everyone with viewer access")} />
            <FormControlLabel value="emails" control={<Radio />} label={t("Only these people")} />
          </RadioGroup>
        </FormControl>
        {kind === "emails" && (
          <TextField
            label={t("Emails")}
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
            helperText={t("One per line, or separated by commas")}
            multiline
            minRows={3}
            fullWidth
            sx={{ mt: 1 }}
          />
        )}
        {why.length > 0 && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {why.length > 1 ? (
              <>
                {t("It cannot be published yet:")}
                <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                  {why.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </>
            ) : (
              why[0]
            )}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        {published && (
          <Button color="error" disabled={busy} onClick={() => void unpublish()} sx={{ mr: "auto" }}>
            {t("Unpublish")}
          </Button>
        )}
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="contained" color="secondary" disabled={!ready} onClick={() => void publish()}>
          {published ? t("Publish again") : t("Publish")}
        </Button>
      </DialogActions>
    </>
  );
}

/** Who may open the published copy, publishing, and taking it down. */
export function PublishDialog(props: { open: boolean; slug: string; published: PublishedInfo | null; onChange(published: PublishedInfo | null): void; onClose(): void }) {
  const { open, ...form } = props;
  return (
    <Dialog open={open} onClose={props.onClose} maxWidth="xs" fullWidth>
      <PublishForm {...form} />
    </Dialog>
  );
}
