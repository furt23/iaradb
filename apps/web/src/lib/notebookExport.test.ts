import type { Cell } from "@workhouse/protocol";
import { describe, expect, it } from "vitest";

import { exportName, fileStem, toIpynb, toMarkdown } from "./notebookExport";

function cell(kind: Cell["kind"], code: string, id = "c1"): Cell {
  return { id, kind, code, name: "_", output: null, config: {}, setup: false };
}

describe("toIpynb", () => {
  it("writes an nbformat 4.5 notebook with one cell per cell", () => {
    const cells = [cell("markdown", "# Intro\nSome text", "m1"), cell("python", "import pandas as pd\nx = 1\n", "p1"), cell("sql", "select *\nfrom t", "s1")];
    expect(JSON.parse(toIpynb(cells, { name: "tour" }))).toEqual({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
        language_info: { name: "python" },
        workhouse: { name: "tour" },
      },
      cells: [
        { cell_type: "markdown", id: "m1", metadata: {}, source: ["# Intro\n", "Some text"] },
        { cell_type: "code", id: "p1", execution_count: null, metadata: {}, outputs: [], source: ["import pandas as pd\n", "x = 1\n"] },
        { cell_type: "code", id: "s1", execution_count: null, metadata: { workhouse: { kind: "sql" } }, outputs: [], source: ["%%sql\n", "select *\n", "from t"] },
      ],
    });
  });

  it("keeps empty cells and indents like Jupyter", () => {
    const nb = JSON.parse(toIpynb([cell("python", "", "e1")], { name: "x" }));
    expect(nb.cells[0].source).toEqual([]);
    expect(toIpynb([], { name: "x" })).toContain('\n "nbformat": 4,');
  });

  it("makes cell ids valid nbformat ids", () => {
    const nb = JSON.parse(toIpynb([cell("python", "1", "bad id!")], { name: "x" }));
    expect(nb.cells[0].id).toBe("bad-id-");
  });
});

describe("toMarkdown", () => {
  it("titles the document and fences code by language", () => {
    const cells = [cell("markdown", "Some text"), cell("python", "x = 1\n"), cell("sql", "select 1\n")];
    expect(toMarkdown(cells, { title: "tour" })).toBe("# tour\n\nSome text\n\n```python\nx = 1\n```\n\n```sql\nselect 1\n```\n");
  });

  it("leaves out empty cells", () => {
    expect(toMarkdown([cell("python", "  \n"), cell("markdown", "")], { title: "t" })).toBe("# t\n");
  });

  it("uses a longer fence when the code holds backticks", () => {
    expect(toMarkdown([cell("python", "print('```')")], { title: "t" })).toBe("# t\n\n````python\nprint('```')\n````\n");
  });
});

describe("export names", () => {
  it("drops the .py or .sql extension", () => {
    expect(fileStem("notebooks/tour.py")).toBe("tour");
    expect(fileStem("queries/Top Sales.sql")).toBe("Top Sales");
    expect(fileStem("notes.txt")).toBe("notes.txt");
    expect(exportName("notebooks/tour.py", ".ipynb")).toBe("tour.ipynb");
    expect(exportName("notebooks/tour.py", ".md")).toBe("tour.md");
  });
});
