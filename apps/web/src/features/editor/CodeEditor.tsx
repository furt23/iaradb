"use client";

import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql, StandardSQL } from "@codemirror/lang-sql";
import { Prec, type Extension } from "@codemirror/state";
import { keymap, tooltips } from "@codemirror/view";
import { useColorScheme } from "@mui/material/styles";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useMemo, useRef } from "react";

import type { EditorAssist } from "./assist";
import { kernelCompletion } from "./completion";
import { editorTheme } from "./editorTheme";
import { kernelLinter } from "./lint";
import { signatureHelp } from "./signatureHelp";
import { sqlNamespace } from "./sqlNamespace";

/**
 * Completions, signatures and lint messages float over the page: inside the
 * editor they are clipped by the cell (a one-line cell hides them entirely).
 * CodeMirror gives the floating container the editor's theme classes.
 */
function floatingTooltips(): Extension {
  return typeof document === "undefined" ? [] : tooltips({ position: "fixed", parent: document.body });
}

export type EditorLanguage = "python" | "sql" | "markdown";

export interface CodeEditorProps {
  value: string;
  onChange?(value: string): void;
  language: EditorLanguage;
  /** Shift+Enter */
  onRun?(): void;
  /** Ctrl/Cmd+Enter */
  onRunInPlace?(): void;
  onSave?(): void;
  /** table -> columns, for SQL completion (a table by its display name, and by its full name in the default catalog) */
  schema?: Record<string, { name: string }[]>;
  readOnly?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  minHeight?: number;
  maxHeight?: number;
  lineNumbers?: boolean;
  /** completions, signature help and diagnostics from the kernel */
  assist?: EditorAssist;
}

function languageExtension(language: EditorLanguage, schema?: CodeEditorProps["schema"]): Extension {
  if (language === "python") return python();
  if (language === "markdown") return markdown();
  return sql({ dialect: StandardSQL, schema: sqlNamespace(schema ?? {}), upperCaseKeywords: false });
}

function assistExtensions(language: EditorLanguage, assist?: EditorAssist): Extension[] {
  if (!assist) return [];
  const out: Extension[] = [];
  if (assist.lint) out.push(kernelLinter(assist.lint));
  if (language === "python" && assist.complete) out.push(kernelCompletion(assist.complete));
  if (language === "python" && assist.signature) out.push(signatureHelp(assist.signature));
  return out;
}

export function CodeEditor(props: CodeEditorProps) {
  const { mode, systemMode } = useColorScheme();
  const scheme = (mode === "system" ? systemMode : mode) ?? "dark";
  // handlers in a ref: callers pass fresh closures on every render, and new
  // extensions would reconfigure the editor (dropping plugin state) per keystroke
  const handlers = useRef(props);
  handlers.current = props;
  const keys = useMemo(() => {
    const call = (name: "onRun" | "onRunInPlace" | "onSave") => () => {
      const f = handlers.current[name];
      if (!f) return false;
      f();
      return true;
    };
    return Prec.highest(
      keymap.of([
        { key: "Shift-Enter", run: call("onRun") },
        { key: "Mod-Enter", run: call("onRunInPlace") },
        { key: "Mod-s", run: call("onSave"), preventDefault: true },
      ]),
    );
  }, []);
  const assist = useMemo(() => assistExtensions(props.language, props.assist), [props.language, props.assist]);
  const extensions = useMemo(
    () => [languageExtension(props.language, props.schema), editorTheme(scheme), keys, floatingTooltips(), ...assist],
    [props.language, props.schema, scheme, keys, assist],
  );
  const onChange = useCallback((value: string) => handlers.current.onChange?.(value), []);
  // the kernel's completions replace the built-in ones (they include them)
  const kernelCompletes = props.language === "python" && !!props.assist?.complete;
  const readOnly = !!props.readOnly;
  const basicSetup = useMemo(
    () => ({
      lineNumbers: props.lineNumbers ?? true,
      foldGutter: false,
      highlightActiveLine: !readOnly,
      highlightActiveLineGutter: !readOnly,
      autocompletion: !kernelCompletes,
      bracketMatching: true,
      closeBrackets: true,
      indentOnInput: true,
      tabSize: 4,
    }),
    [props.lineNumbers, readOnly, kernelCompletes],
  );
  return (
    <CodeMirror
      value={props.value}
      onChange={onChange}
      extensions={extensions}
      theme="none"
      readOnly={props.readOnly}
      editable={!props.readOnly}
      autoFocus={props.autoFocus}
      placeholder={props.placeholder}
      minHeight={props.minHeight ? `${props.minHeight}px` : undefined}
      maxHeight={props.maxHeight ? `${props.maxHeight}px` : undefined}
      basicSetup={basicSetup}
    />
  );
}
