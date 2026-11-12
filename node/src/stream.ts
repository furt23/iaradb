import * as arrow from "apache-arrow";
import type { JsResultStream } from "../native/index.js";

/** A running query whose result is read once, batch by batch. Breaking out of the loop stops the query. */
export class ResultStream implements AsyncIterable<arrow.RecordBatch> {
  private readonly native: JsResultStream;

  /** @internal Wraps a started native stream. */
  constructor(native: JsResultStream) {
    this.native = native;
  }

  /** The result's column types, by name. */
  get schema(): Record<string, string> {
    return Object.fromEntries(this.native.schema().map((f) => [f.name, f.type]));
  }

  /** Stops the query; batches not yet read are dropped. */
  close(): void {
    this.native.close();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<arrow.RecordBatch> {
    try {
      for (;;) {
        const ipc = await this.native.next();
        if (ipc === null) return;
        yield* arrow.tableFromIPC(ipc).batches;
      }
    } finally {
      this.close();
    }
  }
}
