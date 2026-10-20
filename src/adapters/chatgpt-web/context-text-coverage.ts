/** Active-scope UTF-8 coverage. Empty sources require their own successful return. */
export class ContextTextCoverage {
  private readonly intervals = new Map<string, Array<{ start: number; end_exclusive: number }>>();
  private readonly empty = new Set<string>();

  add(targetId: string, range: { start: number; end_exclusive: number }): void {
    if (range.start === range.end_exclusive) { this.empty.add(targetId); return; }
    const ranges = [...(this.intervals.get(targetId) ?? []), { ...range }].sort((a, b) => a.start - b.start);
    const merged: typeof ranges = [];
    for (const entry of ranges) {
      const prior = merged[merged.length - 1];
      if (prior && entry.start <= prior.end_exclusive) prior.end_exclusive = Math.max(prior.end_exclusive, entry.end_exclusive);
      else merged.push({ ...entry });
    }
    this.intervals.set(targetId, merged);
  }

  contains(targetId: string, start: number, end: number, additional?: { start: number; end_exclusive: number }): boolean {
    if (start === end) return this.empty.has(targetId) || additional?.start === start && additional.end_exclusive === end;
    let position = start;
    const ranges = [...(this.intervals.get(targetId) ?? []), ...(additional ? [additional] : [])].sort((a, b) => a.start - b.start);
    for (const range of ranges) {
      if (range.start > position) break;
      position = Math.max(position, range.end_exclusive);
      if (position >= end) return true;
    }
    return false;
  }

  bytes(targetId: string): number { return (this.intervals.get(targetId) ?? []).reduce((sum, entry) => sum + entry.end_exclusive - entry.start, 0); }
  firstGap(targetId: string): number {
    const first = this.intervals.get(targetId)?.[0];
    return first?.start === 0 ? first.end_exclusive : 0;
  }
}
