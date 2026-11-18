// Can wcostream be read at all (18 Nov 2026)? Every page read through Byparr says how it went. When the last few
// reads all failed or came back with nothing on them, wcostream counts as unreadable until one read works again.
// While it is unreadable, nothing is taken as "not listed on wcostream": an empty page then says nothing about a show.

export type ReadOutcome = 'ok' | 'empty' | 'error';
/** why: the reason, without the subject ("the last 5 tries failed (...)"): callers say "wcostream cannot be read". */
export interface WcoVerdict { ok: boolean; why?: string; since?: string }

/** This many failed or empty reads in a row, and none that worked, make wcostream unreadable. */
export const WCO_BAD_RUN = 5;
const KEEP = 20;

export class WcoHealth {
  private recent: { at: number; outcome: ReadOutcome; detail?: string }[] = [];
  private badSince?: number;
  /** Called when the verdict changes, either way. */
  onChange?: (v: WcoVerdict) => void;

  record(outcome: ReadOutcome, detail?: string, at = Date.now()) {
    const before = this.verdict().ok;
    this.recent.push({ at, outcome, detail: detail?.split('\n')[0].slice(0, 200) });
    if (this.recent.length > KEEP) this.recent.splice(0, this.recent.length - KEEP);
    const now = this.verdict();
    if (!now.ok && before) this.badSince = this.recent[this.recent.length - WCO_BAD_RUN].at;
    if (now.ok) this.badSince = undefined;
    if (now.ok !== before) this.onChange?.(this.verdict());
  }

  verdict(): WcoVerdict {
    const last = this.recent.slice(-WCO_BAD_RUN);
    if (last.length < WCO_BAD_RUN || last.some((r) => r.outcome === 'ok')) return { ok: true };
    const since = this.badSince ? new Date(this.badSince).toISOString() : new Date(last[0].at).toISOString();
    const errors = last.filter((r) => r.outcome === 'error');
    const why = errors.length === last.length
      ? `the last ${WCO_BAD_RUN} tries failed (${errors[errors.length - 1].detail ?? 'no reason given'})`
      : `its pages came back with nothing on them (${last.length - errors.length} of the last ${WCO_BAD_RUN} reads): the layout may have changed, or Byparr did not get past a challenge page`;
    return { ok: false, why, since };
  }
}
