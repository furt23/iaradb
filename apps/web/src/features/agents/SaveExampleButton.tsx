"use client";

import BookmarkAdded from "@mui/icons-material/BookmarkAdded";
import BookmarkAddOutlined from "@mui/icons-material/BookmarkAddOutlined";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";

import { useTranslation } from "@/i18n";

/** Keeps a question and its SQL as an example; disabled once the question is one. Sits beside a SqlBlock's copy button. */
export function SaveExampleButton({ saved, onSave }: { saved: boolean; onSave(): void }) {
  const { t } = useTranslation();
  return (
    <Tooltip title={t(saved ? "Saved as example" : "Save as example")}>
      <span>
        <IconButton
          size="small"
          aria-label={t("Save as example")}
          disabled={saved}
          onClick={onSave}
          sx={{ bgcolor: "background.paper", "&:hover": { bgcolor: "action.hover" } }}
        >
          {saved ? <BookmarkAdded sx={{ fontSize: 15 }} /> : <BookmarkAddOutlined sx={{ fontSize: 15 }} />}
        </IconButton>
      </span>
    </Tooltip>
  );
}
