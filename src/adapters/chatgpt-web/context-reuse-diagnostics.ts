interface Observation {
  wireBytes: number; tokens: number; successful: boolean; method: "list" | "read" | "search";
  textBytes?: number; uniqueBytes?: number; reusedSource?: boolean; manifestOrder?: number;
}
const counters = () => ({ returned_calls: 0, returned_wire_bytes: 0, returned_estimated_tokens: 0,
  unique_text_bytes: 0, repeated_text_bytes: 0, reused_source_read_bytes: 0,
  reused_source_read_wire_bytes: 0, reused_source_read_estimated_tokens: 0,
  directory_calls: 0, directory_wire_bytes: 0, manifest_calls: 0, manifest_wire_bytes: 0,
  startup_manifest_wire_bytes: 0, startup_manifest_estimated_tokens: 0 });

function add(total: ReturnType<typeof counters>, value: Observation, startupOrder: number): number {
  total.returned_calls++;
  total.returned_wire_bytes += value.wireBytes;
  total.returned_estimated_tokens += value.tokens;
  const text = value.textBytes ?? 0;
  const unique = value.uniqueBytes ?? 0;
  total.unique_text_bytes += unique;
  total.repeated_text_bytes += Math.max(0, text - unique);
  if (value.reusedSource) {
    total.reused_source_read_bytes += text;
    total.reused_source_read_wire_bytes += value.wireBytes;
    total.reused_source_read_estimated_tokens += value.tokens;
  }
  if (value.method === "list" && value.successful) {
    if (value.manifestOrder !== undefined) {
      // Receipt IPC may arrive out of order. Select the earliest generated return
      // among the confirmed sends, not the first confirmation received.
      if (value.manifestOrder < startupOrder) {
        startupOrder = value.manifestOrder;
        total.startup_manifest_wire_bytes = value.wireBytes;
        total.startup_manifest_estimated_tokens = value.tokens;
      }
      total.manifest_calls++;
      total.manifest_wire_bytes += value.wireBytes;
    } else {
      total.directory_calls++;
      total.directory_wire_bytes += value.wireBytes;
    }
  }
  return startupOrder;
}

/** Transport observations only. No source text, references, credentials or model token claims. */
export class ContextReuseDiagnostics {
  private readonly started: number;
  private readonly totals = counters();
  private startupOrder = Infinity;
  private firstWorkStartupOrder = Infinity;
  private firstWork?: ReturnType<ContextReuseDiagnostics["current"]>;

  constructor(private readonly now: () => number = () => performance.now()) { this.started = now(); }

  sent(value: Observation, beforeFirstWork = false): void {
    this.startupOrder = add(this.totals, value, this.startupOrder);
    // Only receipts captured at the original work boundary may update this snapshot.
    // Its time stays fixed; later navigation contributes only to the live totals.
    if (beforeFirstWork && this.firstWork) this.firstWorkStartupOrder = add(this.firstWork, value, this.firstWorkStartupOrder);
  }

  private current() {
    return { ...this.totals, elapsed_ms: Math.max(0, this.now() - this.started) };
  }

  /** Called once new business or successful completion passes its original admission boundary. */
  freeze(): void {
    if (this.firstWork) return;
    this.firstWork = this.current();
    this.firstWorkStartupOrder = this.startupOrder;
  }

  snapshot() {
    return { ...this.current(), before_first_work: this.firstWork ? { ...this.firstWork } : null,
      actual_model_input_tokens: null };
  }
}
