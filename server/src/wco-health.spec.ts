import { WCO_BAD_RUN, WcoHealth } from './wco-health';

describe('WcoHealth', () => {
  it('turns unreadable after a run of failed or empty reads, and readable at the first read that works', () => {
    const h = new WcoHealth();
    const changes: boolean[] = [];
    h.onChange = (v) => changes.push(v.ok);
    for (let i = 0; i < WCO_BAD_RUN - 1; i++) h.record('error', 'Byparr request failed: ECONNREFUSED\nstack');
    expect(h.verdict().ok).toBe(true);                      // a few failures are ordinary
    h.record('error', 'Byparr request failed: ECONNREFUSED\nstack');
    expect(h.verdict()).toMatchObject({ ok: false, why: expect.stringMatching(/^the last 5 tries failed \(Byparr.*ECONNREFUSED\)$/) });
    expect(h.verdict().why).not.toMatch(/stack/);
    h.record('ok');
    expect(h.verdict().ok).toBe(true);
    expect(changes).toEqual([false, true]);
  });

  it('says the layout may have changed when pages come back empty', () => {
    const h = new WcoHealth();
    h.record('ok');
    for (let i = 0; i < WCO_BAD_RUN; i++) h.record(i % 2 ? 'error' : 'empty', 'x');
    expect(h.verdict()).toMatchObject({ ok: false, why: expect.stringMatching(/nothing on them \(3 of the last 5 reads\).*layout may have changed/) });
    expect(h.verdict().since).toBeDefined();
  });
});
