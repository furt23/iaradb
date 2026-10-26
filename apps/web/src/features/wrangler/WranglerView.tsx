"use client";

import AddBoxOutlined from "@mui/icons-material/AddBoxOutlined";
import ArrowDropDown from "@mui/icons-material/ArrowDropDown";
import BarChartOutlined from "@mui/icons-material/BarChartOutlined";
import CleaningServicesOutlined from "@mui/icons-material/CleaningServicesOutlined";
import Code from "@mui/icons-material/Code";
import DashboardOutlined from "@mui/icons-material/DashboardOutlined";
import FilterList from "@mui/icons-material/FilterList";
import Functions from "@mui/icons-material/Functions";
import MergeTypeOutlined from "@mui/icons-material/MergeTypeOutlined";
import TextFieldsOutlined from "@mui/icons-material/TextFieldsOutlined";
import TransformOutlined from "@mui/icons-material/TransformOutlined";
import ViewColumnOutlined from "@mui/icons-material/ViewColumnOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Alert from "@mui/material/Alert";
import LinearProgress from "@mui/material/LinearProgress";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { DataGrid, type GridColDef } from "@mui/x-data-grid";
import type { CellValue, WranglePreview, WrangleProfile, WrangleSource } from "@iara/protocol";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatCount, isNumericType, typeLabel } from "@/lib/format";
import { ColumnProfileDrawer } from "./ColumnProfileDrawer";
import { QualityBar } from "./QualityBar";
import { RecipeSidebar } from "./RecipeSidebar";
import { CalculatedDialog } from "./dialogs/CalculatedDialog";
import { CleanDialog } from "./dialogs/CleanDialog";
import { ColumnDialog } from "./dialogs/ColumnDialog";
import { DateDialog } from "./dialogs/DateDialog";
import { ExportDialog } from "./dialogs/ExportDialog";
import { FilterDialog } from "./dialogs/FilterDialog";
import { GroupByDialog } from "./dialogs/GroupByDialog";
import { JoinDialog } from "./dialogs/JoinDialog";
import { PivotDialog } from "./dialogs/PivotDialog";
import { TextDialog } from "./dialogs/TextDialog";
import { UseInDashboardDialog } from "./dialogs/UseInDashboardDialog";
import { previewRecipe, profileRecipeColumn } from "@/server/actions/wrangle";
import type { WranglerStep } from "./types";

interface Props {
  /** the kernel holding the source */
  kernelKey: string;
  source: WrangleSource;
  /** shown in the toolbar */
  label: string;
  height?: number | string;
  /** the recipe the view starts with (read once) */
  initialSteps?: WranglerStep[];
  /** called with the recipe after each change the user makes; the recipe is then the caller's, so "Use in dashboard" is hidden */
  onSteps?: (steps: WranglerStep[]) => void;
}

type RowType = { id: number } & Record<string, CellValue>;

function display(v: CellValue): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

type Load = { status: "loading"; last?: WranglePreview } | { status: "ready"; data: WranglePreview } | { status: "failed"; message: string; last?: WranglePreview };

/** The steps a preview runs: the enabled ones, up to the selected step. */
function stepsUpTo(steps: WranglerStep[], activeId: string | null): WranglerStep[] {
  const end = activeId ? steps.findIndex((s) => s.id === activeId) + 1 : steps.length;
  return steps.slice(0, end > 0 ? end : steps.length).filter((s) => s.enabled);
}

export function WranglerView({ kernelKey, source, label, height = "100%", initialSteps, onSteps }: Props) {
  const { t } = useTranslation();
  const [steps, setSteps] = useState<WranglerStep[]>(initialSteps ?? []);
  const [activeStepId, setActiveStepId] = useState<string | null>(null);

  // Active dialog states
  const [filterOpen, setFilterOpen] = useState(false);
  const [cleanOpen, setCleanOpen] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const [columnOpen, setColumnOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [calcOpen, setCalcOpen] = useState(false);
  const [pivotTab, setPivotTab] = useState<"pivot" | "unpivot" | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [menu, setMenu] = useState<{ kind: "add" | "reshape"; anchor: HTMLElement } | null>(null);
  const [selectedColumn, setSelectedColumn] = useState<string | undefined>(undefined);

  // Profile drawer state
  const [profile, setProfile] = useState<WrangleProfile | "loading" | null>(null);

  // the recipe runs in the kernel; the last good preview stays on screen while the next loads
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const shown = stepsUpTo(steps, activeStepId);
  const key = JSON.stringify([kernelKey, source, shown.map((s) => s.op)]);
  useEffect(() => {
    let live = true;
    setLoad((l) => ({ status: "loading", last: l.status === "ready" ? l.data : l.last }));
    void previewRecipe(kernelKey, source, shown).then((r) => {
      if (!live) return;
      setLoad((l) => {
        const last = l.status === "ready" ? l.data : l.last;
        return r.ok ? { status: "ready", data: r.data } : { status: "failed", message: r.error.message, last };
      });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` covers the request
  }, [key]);
  const data = load.status === "ready" ? load.data : load.last;
  const columns = useMemo(() => data?.columns ?? [], [data]);
  const quality = useMemo(() => new Map((data?.quality ?? []).map((q) => [q.name, q])), [data]);

  const openProfile = (column: string) => {
    setProfile("loading");
    void profileRecipeColumn(kernelKey, source, shown, column).then((r) => setProfile(r.ok ? r.data : null));
  };

  const commit = (next: WranglerStep[]) => {
    setSteps(next);
    onSteps?.(next);
  };

  const handleAddStep = (step: WranglerStep) => {
    commit([...steps, step]);
    setActiveStepId(null);
  };

  const handleToggleStep = (id: string) => {
    commit(steps.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
  };

  const handleDeleteStep = (id: string) => {
    commit(steps.filter((s) => s.id !== id));
    if (activeStepId === id) setActiveStepId(null);
  };

  const handleClearSteps = () => {
    commit([]);
    setActiveStepId(null);
  };

  // a recipe over a table can become a dashboard's dataset; one over a result cannot
  const table = "table" in source ? source.table : null;

  const choose = (open: () => void) => {
    setMenu(null);
    setSelectedColumn(undefined);
    open();
  };

  const handleFilterValue = (column: string, value: string, exclude = false) => {
    handleAddStep({
      id: `filter_${Date.now()}`,
      label: `${column} ${exclude ? "!=" : "=="} '${value}'`,
      enabled: true,
      op: { kind: "filter", column, op: exclude ? "not_equals" : "equals", value },
    });
    setProfile(null);
  };

  // rows in DataGrid form
  const rows = useMemo<RowType[]>(
    () =>
      (data?.rows ?? []).map((r, i) => {
        const row: RowType = { id: i };
        r.forEach((v, c) => (row[`c${c}`] = v));
        return row;
      }),
    [data],
  );

  // DataGrid column definitions with QualityBars and quick actions
  const gridColumns = useMemo<GridColDef<RowType>[]>(
    () =>
      columns.map((c, i) => {
        const numeric = isNumericType(c.type);
        const q = quality.get(c.name);

        return {
          field: `c${i}`,
          headerName: c.name,
          minWidth: 150,
          flex: 1,
          align: numeric ? "right" : "left",
          headerAlign: numeric ? "right" : "left",
          valueFormatter: (v: CellValue) => display(v),
          renderHeader: () => (
            <Box sx={{ width: "100%", overflow: "hidden", py: 0.5 }}>
              <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 0.5 }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, minWidth: 0 }}>
                  <Typography noWrap sx={{ fontWeight: 650, fontSize: 12.5 }} title={c.name}>
                    {c.name}
                  </Typography>
                </Box>
                {(
                  <Tooltip title={t("Column statistics")}>
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        openProfile(c.name);
                      }}
                      sx={{ p: 0.25, opacity: 0.7, "&:hover": { opacity: 1, color: "primary.main" } }}
                    >
                      <BarChartOutlined fontSize="small" sx={{ fontSize: 15 }} />
                    </IconButton>
                  </Tooltip>
                )}
              </Box>

              <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mt: 0.25 }}>
                <Typography sx={{ fontSize: 10.5, color: "text.disabled" }} title={c.type}>
                  {typeLabel(c.type)}
                </Typography>
              </Box>

              {q && <QualityBar quality={q} />}
            </Box>
          ),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- openProfile reads the current recipe
    [columns, quality, t],
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height, width: "100%", bgcolor: "background.default" }}>
      {/* Top Action Toolbar */}
      <Box
        sx={{
          px: 2,
          py: 1,
          display: "flex",
          alignItems: "center",
          gap: 1,
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
          flexWrap: "wrap",
        }}
      >
        <Typography variant="mono" noWrap sx={{ fontWeight: 600, mr: 1, maxWidth: 260 }} title={label}>
          {label}
        </Typography>

        <Button
          size="small"
          startIcon={<FilterList fontSize="small" />}
          onClick={() => {
            setSelectedColumn(undefined);
            setFilterOpen(true);
          }}
        >
          {t("Filter")}
        </Button>

        <Button
          size="small"
          startIcon={<CleaningServicesOutlined fontSize="small" />}
          onClick={() => {
            setSelectedColumn(undefined);
            setCleanOpen(true);
          }}
        >
          {t("Clean and impute")}
        </Button>

        <Button
          size="small"
          startIcon={<TextFieldsOutlined fontSize="small" />}
          onClick={() => {
            setSelectedColumn(undefined);
            setTextOpen(true);
          }}
        >
          {t("Text")}
        </Button>

        <Button
          size="small"
          startIcon={<ViewColumnOutlined fontSize="small" />}
          onClick={() => {
            setSelectedColumn(undefined);
            setColumnOpen(true);
          }}
        >
          {t("Columns")}
        </Button>

        <Button
          size="small"
          startIcon={<Functions fontSize="small" />}
          onClick={() => {
            setSelectedColumn(undefined);
            setGroupOpen(true);
          }}
        >
          {t("Group by")}
        </Button>

        <Button
          size="small"
          startIcon={<MergeTypeOutlined fontSize="small" />}
          onClick={() => {
            setSelectedColumn(undefined);
            setJoinOpen(true);
          }}
        >
          {t("Join")}
        </Button>

        <Button
          size="small"
          startIcon={<AddBoxOutlined fontSize="small" />}
          endIcon={<ArrowDropDown fontSize="small" />}
          onClick={(e) => setMenu({ kind: "add", anchor: e.currentTarget })}
        >
          {t("Add column")}
        </Button>

        <Button
          size="small"
          startIcon={<TransformOutlined fontSize="small" />}
          endIcon={<ArrowDropDown fontSize="small" />}
          onClick={(e) => setMenu({ kind: "reshape", anchor: e.currentTarget })}
        >
          {t("Reshape")}
        </Button>

        <Box sx={{ flex: 1 }} />

        <Typography variant="caption" sx={{ color: "text.secondary", mr: 1 }}>
          {data &&
            t(data.num_rows > data.rows.length ? "{{rows}} rows × {{columns}} columns, first {{shown}} shown" : "{{rows}} rows × {{columns}} columns", {
              rows: formatCount(data.num_rows),
              columns: columns.length,
              shown: formatCount(data.rows.length),
            })}
        </Typography>

        {table !== null && !onSteps && (
          <Button size="small" startIcon={<DashboardOutlined fontSize="small" />} onClick={() => setDashboardOpen(true)}>
            {t("Use in dashboard")}
          </Button>
        )}

        <Button
          size="small"
          variant="contained"
          color="primary"
          startIcon={<Code fontSize="small" />}
          onClick={() => setExportOpen(true)}
          disabled={!data}
        >
          {t("Export code")}
        </Button>
      </Box>

      {/* steps on the left, the preview on the right */}
      <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
        <RecipeSidebar
          steps={steps}
          activeStepId={activeStepId}
          onSelectStep={setActiveStepId}
          onToggleStep={handleToggleStep}
          onDeleteStep={handleDeleteStep}
          onClearSteps={handleClearSteps}
        />

        <Box sx={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column", "--mono": "'JetBrains Mono Variable', monospace" }}>
          {load.status === "loading" && <LinearProgress sx={{ height: 2 }} />}
          {load.status === "failed" && (
            <Alert severity="error" sx={{ borderRadius: 0 }}>
              {load.message}
            </Alert>
          )}
          <DataGrid
            rows={rows}
            columns={gridColumns}
            columnHeaderHeight={60}
            rowHeight={32}
            disableRowSelectionOnClick
            disableColumnMenu
            sx={{
              border: 0,
              fontFamily: "'JetBrains Mono Variable', monospace",
              fontSize: 12.5,
              backgroundColor: "transparent",
              "& .MuiDataGrid-columnHeaders": { fontFamily: "inherit" },
              "& .MuiDataGrid-columnHeader, & .MuiDataGrid-filler, & .MuiDataGrid-scrollbarFiller": {
                backgroundColor: "transparent",
                borderBottom: "1px solid",
                borderColor: "text.primary",
              },
              "& .MuiDataGrid-columnSeparator": { display: "none" },
              "& .MuiDataGrid-cell": { borderColor: "divider" },
              "& .MuiDataGrid-row:hover": { backgroundColor: "action.hover" },
            }}
          />
        </Box>
      </Box>

      {/* Action Dialogs */}
      <FilterDialog
        open={filterOpen}
        columns={columns}
        defaultColumn={selectedColumn}
        onClose={() => setFilterOpen(false)}
        onApply={handleAddStep}
      />

      <CleanDialog
        open={cleanOpen}
        columns={columns}
        defaultColumn={selectedColumn}
        onClose={() => setCleanOpen(false)}
        onApply={handleAddStep}
      />

      <TextDialog
        open={textOpen}
        columns={columns}
        defaultColumn={selectedColumn}
        onClose={() => setTextOpen(false)}
        onApply={handleAddStep}
      />

      <ColumnDialog
        open={columnOpen}
        columns={columns}
        defaultColumn={selectedColumn}
        onClose={() => setColumnOpen(false)}
        onApply={handleAddStep}
      />

      <GroupByDialog
        open={groupOpen}
        columns={columns}
        defaultColumn={selectedColumn}
        onClose={() => setGroupOpen(false)}
        onApply={handleAddStep}
      />

      <JoinDialog
        open={joinOpen}
        columns={columns}
        defaultColumn={selectedColumn}
        onClose={() => setJoinOpen(false)}
        onApply={handleAddStep}
      />

      <DateDialog
        open={dateOpen}
        columns={columns}
        defaultColumn={selectedColumn}
        onClose={() => setDateOpen(false)}
        onApply={handleAddStep}
      />

      <CalculatedDialog
        open={calcOpen}
        columns={columns}
        defaultColumn={selectedColumn}
        onClose={() => setCalcOpen(false)}
        onApply={handleAddStep}
      />

      <PivotDialog
        open={pivotTab !== null}
        initialTab={pivotTab ?? "pivot"}
        columns={columns}
        defaultColumn={selectedColumn}
        onClose={() => setPivotTab(null)}
        onApply={handleAddStep}
      />

      <Menu anchorEl={menu?.anchor} open={menu?.kind === "add"} onClose={() => setMenu(null)}>
        <MenuItem onClick={() => choose(() => setDateOpen(true))}>{t("Date part…")}</MenuItem>
        <MenuItem onClick={() => choose(() => setCalcOpen(true))}>{t("Calculated column…")}</MenuItem>
      </Menu>

      <Menu anchorEl={menu?.anchor} open={menu?.kind === "reshape"} onClose={() => setMenu(null)}>
        <MenuItem onClick={() => choose(() => setPivotTab("pivot"))}>{t("Pivot…")}</MenuItem>
        <MenuItem onClick={() => choose(() => setPivotTab("unpivot"))}>{t("Unpivot…")}</MenuItem>
      </Menu>

      {table !== null && !onSteps && (
        <UseInDashboardDialog open={dashboardOpen} table={table} steps={steps} onClose={() => setDashboardOpen(false)} />
      )}

      {data && <ExportDialog open={exportOpen} sql={data.sql} python={data.python} onClose={() => setExportOpen(false)} />}

      {/* Column Profiling Drawer */}
      <ColumnProfileDrawer profile={profile} onClose={() => setProfile(null)} onFilterValue={handleFilterValue} />
    </Box>
  );
}
