"use client";

import BarChartOutlined from "@mui/icons-material/BarChartOutlined";
import Close from "@mui/icons-material/Close";
import FilterList from "@mui/icons-material/FilterList";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import type { WrangleProfile } from "@workhouse/protocol";
import { typeLabel } from "@/lib/format";

interface Props {
  /** "loading" while the kernel computes it */
  profile: WrangleProfile | "loading" | null;
  onClose: () => void;
  onFilterValue?: (column: string, value: string, exclude?: boolean) => void;
}

export function ColumnProfileDrawer({ profile, onClose, onFilterValue }: Props) {
  if (!profile) return null;
  if (profile === "loading") {
    return (
      <Drawer anchor="right" open onClose={onClose} slotProps={{ paper: { sx: { width: 380, p: 2.5, alignItems: "center", justifyContent: "center" } } }}>
        <CircularProgress size={24} />
      </Drawer>
    );
  }

  const total = Math.max(profile.total, 1);
  const validPct = Math.round(((profile.total - profile.nulls) / total) * 100);
  const nullPct = Math.round((profile.nulls / total) * 100);
  const numeric = profile.mean !== undefined;

  return (
    <Drawer anchor="right" open={Boolean(profile)} onClose={onClose} slotProps={{ paper: { sx: { width: 380, p: 2.5 } } }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 2 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <BarChartOutlined sx={{ color: "primary.main" }} />
          <Typography variant="h3">{profile.name}</Typography>
        </Box>
        <IconButton size="small" onClick={onClose}>
          <Close fontSize="small" />
        </IconButton>
      </Box>

      <Box sx={{ display: "flex", gap: 1, mb: 2 }}>
        <Chip label={typeLabel(profile.type)} title={profile.type} size="small" variant="outlined" sx={{ fontSize: 11 }} />
        <Chip label={`${profile.total} rows`} size="small" variant="outlined" />
      </Box>

      <Typography variant="overline" sx={{ color: "text.secondary", fontSize: 10 }}>
        Completeness
      </Typography>
      <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 1, my: 1 }}>
        <Box sx={{ p: 1, border: 1, borderColor: "divider", borderRadius: 1, textAlign: "center" }}>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            Valid
          </Typography>
          <Typography sx={{ fontWeight: 700, color: "success.main" }}>{validPct}%</Typography>
        </Box>
        <Box sx={{ p: 1, border: 1, borderColor: "divider", borderRadius: 1, textAlign: "center" }}>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            Null
          </Typography>
          <Typography sx={{ fontWeight: 700, color: nullPct > 0 ? "warning.main" : "text.secondary" }}>{nullPct}%</Typography>
        </Box>
        <Box sx={{ p: 1, border: 1, borderColor: "divider", borderRadius: 1, textAlign: "center" }}>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            Distinct
          </Typography>
          <Typography sx={{ fontWeight: 700 }}>{profile.distinct}</Typography>
        </Box>
      </Box>

      {numeric && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="overline" sx={{ color: "text.secondary", fontSize: 10 }}>
            Statistics
          </Typography>
          <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, my: 1 }}>
            <Box sx={{ display: "flex", justifyContent: "space-between", py: 0.25 }}>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                Min:
              </Typography>
              <Typography variant="mono">{String(profile.min)}</Typography>
            </Box>
            <Box sx={{ display: "flex", justifyContent: "space-between", py: 0.25 }}>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                Max:
              </Typography>
              <Typography variant="mono">{String(profile.max)}</Typography>
            </Box>
            <Box sx={{ display: "flex", justifyContent: "space-between", py: 0.25 }}>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                Mean:
              </Typography>
              <Typography variant="mono">{profile.mean}</Typography>
            </Box>
            <Box sx={{ display: "flex", justifyContent: "space-between", py: 0.25 }}>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                Median:
              </Typography>
              <Typography variant="mono">{profile.median}</Typography>
            </Box>
            {profile.std !== null && profile.std !== undefined && (
              <Box sx={{ display: "flex", justifyContent: "space-between", py: 0.25, gridColumn: "span 2" }}>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  Std dev:
                </Typography>
                <Typography variant="mono">{profile.std}</Typography>
              </Box>
            )}
          </Box>
        </>
      )}

      <Divider sx={{ my: 2 }} />
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 1 }}>
        <Typography variant="overline" sx={{ color: "text.secondary", fontSize: 10 }}>
          Top values
        </Typography>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {profile.top.length} of {profile.distinct}
        </Typography>
      </Box>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, maxHeight: 360, overflow: "auto" }}>
        {profile.top.map((f, i) => (
          <Box key={i} sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
            <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Typography variant="mono" noWrap sx={{ maxWidth: 220, fontSize: 12 }}>
                {f.value}
              </Typography>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {f.count} ({Math.round(f.share * 100)}%)
                </Typography>
                {onFilterValue && (
                  <Tooltip title={`Filter to rows where ${profile.name} = '${f.value}'`}>
                    <IconButton size="small" onClick={() => onFilterValue(profile.name, f.value, false)}>
                      <FilterList fontSize="inherit" sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Tooltip>
                )}
              </Box>
            </Box>
            <LinearProgress variant="determinate" value={f.share * 100} sx={{ height: 4, borderRadius: 1 }} />
          </Box>
        ))}
      </Box>
    </Drawer>
  );
}
