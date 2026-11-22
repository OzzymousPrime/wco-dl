import axios from 'axios';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppConfig } from './config';
import { FillService } from './fill.service';

/**
 * End-to-end tests of the fill worker with a fake Sonarr (axios mocked) and a fake downloader (a node script
 * that writes the file name given in FAKE_FILE, or prints a premium-only line). They pin the rules from
 * 11 Nov 2026: import only the episode asked for, never a sub as a dub swap, premium goes to Sonarr.
 */
// These tests start a real child process and wait on it; on a busy machine 5 seconds is not enough.
jest.setTimeout(30000);

describe('FillService worker', () => {
  let dir: string;
  let calls: { method: string; url: string; data?: any }[];
  let hasFile: Record<number, boolean>;
  let fakeOut: { file?: string; premium?: boolean };
  /** What ffprobe "finds" in the fake downloader's one-byte files: a 24-minute video unless a test says otherwise. */
  let probeAnswer: any;
  let calendarEps: any[];

  const episodes = [
    { id: 101, seasonNumber: 2, episodeNumber: 14, absoluteEpisodeNumber: 39, title: 'Straight Bet', airDate: '2021-01-13', airDateUtc: '2021-01-13T15:00:00Z' },
    { id: 102, seasonNumber: 2, episodeNumber: 15, absoluteEpisodeNumber: 40, title: 'Otto Suwen', airDate: '2021-01-20', airDateUtc: '2021-01-20T15:00:00Z', episodeFileId: 9 },
    { id: 103, seasonNumber: 2, episodeNumber: 16, absoluteEpisodeNumber: 41, title: 'Bonds of Lust', airDate: '2021-01-27', airDateUtc: '2021-01-27T15:00:00Z', episodeFileId: 10 },
  ];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fill-'));
    calls = [];
    hasFile = { 101: false, 102: true, 103: true };
    fakeOut = {};
    const script = path.join(dir, 'fake.js');
    await fs.writeFile(script, `
      const fs = require('fs'), path = require('path');
      const o = process.argv[process.argv.indexOf('-o') + 1];
      const want = JSON.parse(process.env.FAKE || '{}');
      if (want.args) fs.writeFileSync(want.args, JSON.stringify(process.argv.slice(2)));
      if (want.skip) { console.log('[wco-dl] - x skipped, already downloaded.'); process.exit(0); }
      if (want.busy) { console.log('[wco-dl] - Could not find a video for x: Embed player returned HTTP 503: Servers Busy'); process.exit(0); }
      if (want.premium) { console.log('[wco-dl] - Skipping https://www.wcostream.tv/x-episode-14-english-dubbed, it is only available to WCO Premium users.'); process.exit(0); }
      console.log('Downloading:  50%|#####'); fs.writeFileSync(path.join(o, want.file), 'x'); console.log('Downloading: 100%|##########');
    `);
    jest.spyOn(axios, 'request').mockImplementation(async (req: any) => {
      const url = String(req.url).replace(/^.*\/api\/v3\//, '');
      calls.push({ method: req.method, url, data: req.data });
      if (url.startsWith('episode?seriesId')) return { data: episodes.map((e) => ({ ...e, hasFile: hasFile[e.id] })) };
      if (url.startsWith('episodefile?')) return { data: [
        { id: 9, relativePath: 'x - 2x15.mkv', mediaInfo: { audioLanguages: 'jpn' }, quality: { quality: { name: 'HDTV-1080p' } } },
        { id: 10, relativePath: 'x - 2x16.mkv', mediaInfo: { audioLanguages: 'jpn/eng' }, quality: { quality: { name: 'HDTV-1080p' } } }] };
      if (url.startsWith('series/')) return { data: { id: 575, title: 'Re: ZERO' } };
      if (url.startsWith('calendar?')) return { data: calendarEps };
      if (url.startsWith('manualimport?')) {
        const folder = decodeURIComponent(url.match(/folder=([^&]+)/)![1]);
        const files = (await fs.readdir(folder)).filter((f) => f.endsWith('.mp4'));
        return { data: files.map((f) => ({ path: path.join(folder, f), quality: { quality: { name: 'WEBDL-1080p' } } })) };
      }
      if (url === 'command' && req.data?.name === 'ManualImport') { hasFile[req.data.files[0].episodeIds[0]] = true; return { data: { id: 1 } }; }
      if (url === 'command') return { data: { id: 2 } };
      if (url.startsWith('command/')) return { data: { status: 'completed' } };
      if (url.startsWith('episode/')) { const id = Number(url.split('/')[1]); return { data: { hasFile: !!hasFile[id] } }; }
      return { data: {} };
    });
    const config = {
      sonarrUrl: 'http://sonarr', sonarrApiKey: 'k', outputBase: path.join(dir, 'out'), sonarrImportBase: undefined,
      configDir: path.join(dir, 'config'), pythonBin: process.execPath, pythonScript: script, downloadIdleTimeoutMs: 20000,
    } as unknown as AppConfig;
    service = new FillService(config);
    probeAnswer = { read: true, video: true, seconds: 1440 };
    calendarEps = [];
    jest.spyOn(service as any, 'probe').mockImplementation(async () => probeAnswer);
    process.env.FAKE = '{}';
  });
  // The queue may still be saving when a test ends (run() returns once no episode is active, before the last save):
  // deleting the folder under it failed the next test now and then (EPERM or ENOENT on rename). Let it settle first,
  // and Windows may still hold a file a moment longer: retry.
  afterEach(async () => {
    for (let i = 0; i < 100 && (service as any).running; i++) await new Promise((r) => setTimeout(r, 20));
    await (service as any).saving?.catch(() => undefined);
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  let service: FillService;

  async function run(episodeIds: number[], fake: object) {
    process.env.FAKE = JSON.stringify(fake);
    const job = await service.createJob({ seriesId: 575, slug: 're-zero', language: 'dub', episodeIds });
    for (let i = 0; i < 250 && job.episodes.some((e) => ['queued', 'downloading', 'importing'].includes(e.state)); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return job;
  }

  it('downloads a missing episode and imports it into that episode only', async () => {
    const job = await run([101], { file: 'Re Zero-S02E14-English Dubbed.mp4' });
    expect(job.episodes[0]).toMatchObject({ state: 'done', mode: 'missing' });
    const imp = calls.find((c) => c.data?.name === 'ManualImport');
    expect(imp!.data.files[0].episodeIds).toEqual([101]);
    expect(calls.find((c) => c.url.startsWith('manualimport?'))!.url).not.toMatch(/seriesId/);
  });

  // 17 Nov 2026: only names and sizes were checked before an import.
  it('keeps a file that will not open, has no video, or is far shorter than an episode', async () => {
    probeAnswer = { read: false, video: false };
    let job = await run([101], { file: 'Re Zero-S02E14-English Dubbed.mp4' });
    expect(job.episodes[0]).toMatchObject({ state: 'kept', message: expect.stringMatching(/would not open.*not imported/) });

    probeAnswer = { read: true, video: false, seconds: 1400 };
    job = await run([101], { file: 'Re Zero-S02E14-English Dubbed.mp4' });
    expect(job.episodes[0].message).toMatch(/no video/);

    (service as any).seriesCache = { at: Date.now(), list: [{ id: 575, title: 'Re: ZERO', runtime: 25 }] };
    probeAnswer = { read: true, video: true, seconds: 150 };
    job = await run([101], { file: 'Re Zero-S02E14-English Dubbed.mp4' });
    expect(job.episodes[0].message).toMatch(/runs 3 minutes; this show's episodes run about 25/);
    expect(calls.some((c) => c.data?.name === 'ManualImport')).toBe(false);

    probeAnswer = { read: true, video: true, seconds: 11 * 60 };       // one 11-minute segment against 25: imported
    job = await run([101], { file: 'Re Zero-S02E14-English Dubbed.mp4' });
    expect(job.episodes[0].state).toBe('done');
  });

  it('starts nothing while the downloads drive is under the free-space limit', async () => {
    (service as any).config.minFreeGb = 1e9;                           // more than any drive has
    const job = await service.createJob({ seriesId: 575, slug: 're-zero', language: 'dub', episodeIds: [101] });
    await new Promise((r) => setTimeout(r, 400));
    expect(job.episodes[0].state).toBe('queued');
    expect(calls.some((c) => c.url.startsWith('manualimport?'))).toBe(false);
    const { disk } = await service.queueState();
    expect(disk).toMatchObject({ low: true, minGb: 1e9 });
    expect(disk.freeGb).toBeGreaterThan(0);
    clearTimeout((service as any).diskTimer);

    (service as any).config.minFreeGb = 0;                             // 0 turns the check off
    expect((await service.queueState()).disk.low).toBe(false);
  });

  it('tells once when wcostream lists in English an episode a followed dub show is waiting for', async () => {
    await service.setFollow({ slug: 're-zero', seriesId: 575, follow: true, language: 'dub' });
    const W = 'https://www.wcostream.tv/';
    (service as any).wco = { peek: () => undefined, listing: jest.fn().mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('./wco-episodes.util').buildListing([W + 're-zero-season-2-episode-14-english-dubbed'])) };
    calendarEps = episodes.map((e) => ({ seriesId: 575, seasonNumber: e.seasonNumber, hasFile: hasFile[e.id],
      episodeFile: e.id === 102 ? { mediaInfo: { audioLanguages: 'jpn' } } : e.id === 103 ? { mediaInfo: { audioLanguages: 'jpn/eng' } } : undefined }));
    (service as any).config.notifyUrl = 'http://notify';
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: {} });
    const now = new Date('2021-02-01T12:00:00Z');

    const found = await service.checkNewDubs(now);
    expect(found).toEqual([{ show: 'Re: ZERO', slug: 're-zero', seriesId: 575, episodes: ['2x14'] }]);   // 2x15 is not listed; 2x16 is in English
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toMatchObject({ title: 'New dub: Re: ZERO', body: expect.stringContaining('Re: ZERO 2x14') });

    expect(await service.checkNewDubs(now)).toEqual([]);              // told once
    expect(post).toHaveBeenCalledTimes(1);
    expect(await service.checkNewDubs(new Date('2021-06-01T12:00:00Z'))).toEqual([]);   // older than three weeks: not looked at
  });

  it('keeps a file that is a different episode', async () => {
    const job = await run([101], { file: 'Re Zero-S02E15-English Dubbed.mp4' });
    expect(job.episodes[0].state).toBe('kept');
    expect(calls.some((c) => c.data?.name === 'ManualImport')).toBe(false);
  });

  it('hands a premium-only episode to Sonarr', async () => {
    const job = await run([101], { premium: true });
    expect(job.episodes[0].state).toBe('premium');
    expect(calls.find((c) => c.url === 'episode/monitor')!.data).toEqual({ episodeIds: [101], monitored: true });
    expect(calls.find((c) => c.data?.name === 'EpisodeSearch')!.data.episodeIds).toEqual([101]);
  });

  it('never swaps in a file that is not a dub', async () => {
    const job = await run([102], { file: 'Re Zero-S02E15-English Subbed.mp4' });
    expect(job.episodes[0]).toMatchObject({ mode: 'swap', state: 'kept' });
    expect(calls.some((c) => c.data?.name === 'ManualImport')).toBe(false);
  });

  it('swaps in a dub and refuses episodes that need no work', async () => {
    const job = await run([102], { file: 'Re Zero-S02E15-English Dubbed.mp4' });
    expect(job.episodes[0]).toMatchObject({ mode: 'swap', state: 'done' });
    await expect(service.createJob({ seriesId: 575, slug: 're-zero', episodeIds: [103] })).rejects.toThrow(/needs work/);
  });

  // 13 Nov 2026: Sonarr's history showed files filed under the wrong episode where the site packs two segments
  // into one numbered episode. These pin the cure: the title picks the link, one file can fill two episodes, and
  // a file whose own title is another episode is never imported.
  describe('which link is which episode', () => {
    const W = 'https://www.wcostream.tv/';
    const was = [...episodes];
    const paw = [
      { id: 201, seasonNumber: 1, episodeNumber: 1, title: 'Pups Make a Splash', airDate: '2013-08-12', airDateUtc: '2013-08-12T15:00:00Z', episodeFileId: 10 },
      { id: 202, seasonNumber: 1, episodeNumber: 2, title: 'Pups Fall Festival', airDate: '2013-08-12', airDateUtc: '2013-08-12T15:00:00Z' },
      { id: 203, seasonNumber: 1, episodeNumber: 3, title: 'Pups Save the Sea Turtles', airDate: '2013-08-13', airDateUtc: '2013-08-13T15:00:00Z' },
      { id: 204, seasonNumber: 1, episodeNumber: 4, title: 'Pup and the Very Big Baby', airDate: '2013-08-13', airDateUtc: '2013-08-13T15:00:00Z' },
      { id: 205, seasonNumber: 1, episodeNumber: 5, title: 'Pups and the Kitty-tastrophe', airDate: '2013-08-14', airDateUtc: '2013-08-14T15:00:00Z' },
    ];
    const links = [W + 'paw-episode-1-pups-make-a-splash-pups-fall-festival', W + 'paw-episode-2-pups-save-the-sea-turtles-pup-and-the-very-big-baby',
      W + 'paw-episode-5-video-storybook-pup-pup-and-away'];
    let argsFile: string;
    const stub = (listing: unknown) => { (service as any).wco = { listing: jest.fn().mockResolvedValue(listing), peek: () => undefined }; };
    beforeEach(() => {
      episodes.splice(0, episodes.length, ...(paw as any[]));
      hasFile = { 201: true, 202: false, 203: false, 204: false, 205: false };
      argsFile = path.join(dir, 'args.json');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      stub(require('./wco-episodes.util').buildListing(links));
    });
    afterEach(() => { episodes.splice(0, episodes.length, ...was); });
    const sentArgs = async () => JSON.parse(await fs.readFile(argsFile, 'utf8').catch(() => 'null'));

    it('downloads the link that carries the title and files it under both of its episodes', async () => {
      const job = await run([203], { file: 'Paw-S01E02-Pups Save The Sea Turtles Pup And The Very Big Baby.mp4', args: argsFile });
      expect(job.episodes[0]).toMatchObject({ state: 'done' });
      expect(job.episodes[0].message).toMatch(/one file for 2 episodes/);
      const args = await sentArgs();
      expect(args).toContain(links[1]);                  // the episode link itself, not the show by number
      expect(args).not.toContain('-se');
      const file = calls.find((c) => c.data?.name === 'ManualImport')!.data.files[0];
      expect(file.episodeIds).toEqual([203, 204]);
      expect(file.releaseType).toBe('multiEpisode');
    });

    it('leaves alone an episode of the pair that already has a file', async () => {
      const job = await run([202], { file: 'Paw-S01E01-Pups Make A Splash Pups Fall Festival.mp4', args: argsFile });
      expect(job.episodes[0].state).toBe('done');
      const file = calls.find((c) => c.data?.name === 'ManualImport')!.data.files[0];
      expect(file.episodeIds).toEqual([202]);            // 201 keeps the file it has
      expect(file.releaseType).toBe('singleEpisode');
    });

    it('does not start a download when the number is a different episode and no link has the title', async () => {
      const job = await run([205], { file: 'never.mp4', args: argsFile });
      expect(job.episodes[0].state).toBe('failed');
      expect(job.episodes[0].message).toMatch(/is another episode/);
      expect(await sentArgs()).toBeNull();
    });

    it('with the site list unreadable, a file whose own title is another episode is kept and not imported', async () => {
      stub(undefined);
      const job = await run([202], { file: 'Paw-S01E02-Pups Save The Sea Turtles Pup And The Very Big Baby.mp4', args: argsFile });
      expect(job.episodes[0].state).toBe('kept');
      expect(job.episodes[0].message).toMatch(/different episode from "Pups Fall Festival"/);
      expect(calls.some((c) => c.data?.name === 'ManualImport')).toBe(false);
    });
  });

  it('waits and retries when wcostream says its servers are busy', async () => {
    process.env.FAKE = JSON.stringify({ busy: true });
    const job = await service.createJob({ seriesId: 575, slug: 're-zero', language: 'dub', episodeIds: [101] });
    for (let i = 0; i < 50 && !job.episodes[0].notBefore; i++) await new Promise((r) => setTimeout(r, 100));
    expect(job.episodes[0]).toMatchObject({ state: 'queued', busy: 1 });
    expect(job.episodes[0].message).toMatch(/busy; trying again in 5 minutes/);
  });

  it('refuses a second run for episodes already queued', async () => {
    process.env.FAKE = JSON.stringify({ file: 'Re Zero-S02E14-English Dubbed.mp4' });
    (service as any).running = true;   // hold the queue so the first run stays queued
    await service.createJob({ seriesId: 575, slug: 're-zero', language: 'dub', episodeIds: [101] });
    await expect(service.createJob({ seriesId: 575, slug: 're-zero', language: 'dub', episodeIds: [101] })).rejects.toThrow(/already in the queue/);
    (service as any).running = false;
  });

  it('does not download an episode that another run filled while it waited', async () => {
    process.env.FAKE = JSON.stringify({ file: 'Re Zero-S02E14-English Dubbed.mp4' });
    (service as any).running = true;   // hold the queue so the run stays queued
    const job = await service.createJob({ seriesId: 575, slug: 're-zero', language: 'dub', episodeIds: [101] });
    hasFile[101] = true;               // filled meanwhile
    (service as any).running = false;
    await (service as any).pump();
    expect(job.episodes[0]).toMatchObject({ state: 'done', message: 'Already in the library' });
    expect(calls.some((c) => c.data?.name === 'ManualImport')).toBe(false);
  });

  it('starts nothing while paused, and a run moved to the front goes first', async () => {
    process.env.FAKE = JSON.stringify({ file: 'Re Zero-S02E14-English Dubbed.mp4' });
    await service.setPaused(true);
    const first = await service.createJob({ seriesId: 575, slug: 're-zero', language: 'dub', episodeIds: [101] });
    const second = await service.createJob({ seriesId: 575, slug: 're-zero', language: 'dub', episodeIds: [102], auto: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(first.episodes[0].state).toBe('queued');
    await service.runNext(second.id);
    expect(service.listJobs().map((j) => j.id)).toEqual([first.id, second.id]);   // listed newest first, so the head of the queue is last
    expect(second.auto).toBe(false);
    expect((await service.queueState()).paused).toBe(true);
    await service.setPaused(false);
    for (let i = 0; i < 100 && first.episodes[0].state !== 'done'; i++) await new Promise((r) => setTimeout(r, 100));
    expect(first.episodes[0].state).toBe('done');
  });

  it('lists what needs a person, until it is dismissed or retried', async () => {
    const job = await run([101], { file: 'Re Zero-S02E15-English Dubbed.mp4' });   // the wrong episode: kept
    expect(await service.attention()).toMatchObject([{ jobId: job.id, id: 101, state: 'kept', show: 'Re: ZERO' }]);
    await service.dismiss(job.id, 101);
    expect(await service.attention()).toEqual([]);
    process.env.FAKE = JSON.stringify({ file: 'Re Zero-S02E14-English Dubbed.mp4' });
    await service.retryEpisode(job.id, 101);
    for (let i = 0; i < 100 && job.episodes[0].state !== 'done'; i++) await new Promise((r) => setTimeout(r, 100));
    expect(job.episodes[0]).toMatchObject({ state: 'done', dismissed: undefined });
    expect(await service.attention()).toEqual([]);
  });

  it('gives a failed episode one more go when the queue runs dry, and only one', async () => {
    const job = await run([101], {});   // the fake downloader writes no file and crashes: failed
    expect(job.episodes[0]).toMatchObject({ state: 'failed', autoRetried: true });
    await (service as any).pump();
    expect(job.episodes[0].state).toBe('failed');
    expect(await service.attention()).toMatchObject([{ id: 101, state: 'failed' }]);
  });

  it('leaves unlisted episodes out of tonight\'s plan and counts them as a try', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildListing } = require('./wco-episodes.util');
    const wco = { listing: jest.fn().mockResolvedValue(buildListing(['https://www.wcostream.tv/catdog-episode-1-english-dubbed', 'https://www.wcostream.tv/catdog-episode-2-english-dubbed'])) };
    const svc = new FillService({ configDir: path.join(dir, 'config') } as unknown as AppConfig, wco as any);
    const pref: any = { seriesId: 1, title: 'CatDog', language: 'dub' };
    const tries: any = {};
    const map: any[] = [1, 2, 3, 23].map((e, i) => ({ id: 100 + i, s: 1, e, st: 'missing' }));
    const kept = await (svc as any).dropUnlisted('catdog', pref, map, [100, 101, 102, 103], tries, Date.now() + 60000);
    expect(kept).toEqual([100, 101]);
    expect(pref.unlisted.ids).toEqual([102, 103]);
    expect(tries[102].n).toBe(1);
    // an unreadable list drops nothing
    wco.listing.mockResolvedValue(undefined);
    expect(await (svc as any).dropUnlisted('catdog', { ...pref }, map, [100, 102], {}, Date.now() + 60000)).toEqual([100, 102]);
    // past the deadline nothing is read
    wco.listing.mockClear();
    expect(await (svc as any).dropUnlisted('catdog', { ...pref }, map, [100, 102], {}, Date.now() - 1)).toEqual([100, 102]);
    expect(wco.listing).not.toHaveBeenCalled();
  });

  // 18 Nov 2026: an old episode left out at two checks running goes to Sonarr then, not after four tries.
  it('hands an old episode wcostream left out twice to Sonarr, once, and believes no list while wcostream is unreadable', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildListing } = require('./wco-episodes.util');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { WcoHealth } = require('./wco-health');
    const health = new WcoHealth();
    const wco = { health, listing: jest.fn().mockResolvedValue(buildListing(['https://www.wcostream.tv/catdog-episode-1-english-dubbed'])) };
    const svc = new FillService({ configDir: path.join(dir, 'config') } as unknown as AppConfig, wco as any);
    const recent = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const map: any[] = [
      { id: 100, s: 1, e: 1, st: 'missing', a: '2020-01-01' },
      { id: 101, s: 1, e: 2, st: 'missing', a: '2020-01-08' },     // aired long ago: handed over at the second check
      { id: 102, s: 1, e: 3, st: 'missing', a: recent },           // aired this week: the dub may still come
      { id: 103, s: 1, e: 4, st: 'undub', a: '2020-01-22' },       // has a file already: Sonarr is not asked
    ];
    const pref: any = { seriesId: 1, title: 'CatDog', language: 'dub' }, tries: any = {}, handOff: any[] = [];
    const drop = (p: any, due: number[], t: any) => (svc as any).dropUnlisted('catdog', p, map, due, t, Date.now() + 60000, handOff);
    await drop(pref, [100, 101, 102, 103], tries);
    expect(handOff).toEqual([]);                                    // first time left out: not yet
    await drop(pref, [101, 102, 103], tries);
    expect(handOff.map((h) => h.eps.map((e: any) => e.id))).toEqual([[101]]);
    tries[101].handedToSonarr = true; handOff.length = 0;
    await drop(pref, [101], tries);
    expect(handOff).toEqual([]);                                    // once only

    for (let i = 0; i < 5; i++) health.record('empty', 'catdog');   // wcostream unreadable: an empty page says nothing
    const p2: any = { ...pref, unlisted: { ids: [101], at: '' } }, t2: any = {};
    expect(await drop(p2, [100, 101, 102], t2)).toEqual([100, 101, 102]);
    expect(p2.unlisted.ids).toEqual([101]); expect(t2).toEqual({}); expect(handOff).toEqual([]);
  });

  it('asks Sonarr for the handed-over episodes in one search, only while wcostream reads properly', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildListing } = require('./wco-episodes.util');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { WcoHealth } = require('./wco-health');
    const health = new WcoHealth();
    const wco = { health, peek: () => undefined, listing: jest.fn().mockResolvedValue(buildListing(['https://www.wcostream.tv/re-zero-season-2-episode-15-english-dubbed'])) };
    const svc = new FillService((service as any).config, wco as any);
    await svc.setFollow({ slug: 're-zero', seriesId: 575, follow: true, language: 'dub' });
    const leftOut = async () => (svc as any).changePrefs((p: any) => {
      p['re-zero'].unlisted = { ids: [101], at: '2021-02-01T00:00:00Z' };
      p['re-zero'].tries = { 101: { n: 1, last: '2021-02-01T00:00:00Z' } };
    });
    const searches = () => calls.filter((c) => c.data?.name === 'EpisodeSearch');

    for (let i = 0; i < 5; i++) health.record('error', 'Byparr down');
    await leftOut();
    await svc.setPaused(true);                                        // the plan's runs wait, whatever the hour
    await svc.nightlyPlan();
    expect(searches()).toEqual([]);                                  // unreadable: nothing handed over...
    expect((svc as any).jobs.flatMap((j: any) => j.episodes.map((e: any) => e.id))).toContain(101);   // ...it is tried as usual

    (svc as any).jobs = [];
    health.record('ok');
    await leftOut();
    await svc.nightlyPlan();
    expect(searches().map((c) => c.data.episodeIds)).toEqual([[101]]);
    expect(calls.find((c) => c.url === 'episode/monitor')!.data).toEqual({ episodeIds: [101], monitored: true });
    expect((await (svc as any).prefs())['re-zero'].tries[101]).toMatchObject({ n: 2, handedToSonarr: true });
  });

  // 18 Nov 2026: Kazoops! was linked to KonoSuba's page, and every night planned episodes that could never match.
  it('leaves a show linked to another show out of the plan, says so, and takes it back once the link is called right', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildListing } = require('./wco-episodes.util');
    const wco = { peek: () => undefined, listing: jest.fn().mockResolvedValue(buildListing([14, 15, 16].map((n) => `https://www.wcostream.tv/konosuba-season-2-episode-${n}-english-dubbed`))) };
    const svc = new FillService((service as any).config, wco as any);
    (svc as any).seriesCache = { at: Date.now(), list: [{ id: 575, title: 'Re: ZERO', titleSlug: 're-zero' }] };
    await svc.setFollow({ slug: 'konosuba', seriesId: 575, follow: true, language: 'dub' });
    await svc.setPaused(true);
    expect(await svc.nightlyPlan()).toEqual([]);
    const row = (await svc.followed()).find((x) => x.slug === 'konosuba')!;
    expect(row.linkWrong).toMatch(/name on wcostream is not one of the show's names/);
    expect((svc as any).nightNotes.join('\n')).toMatch(/Re: ZERO: the link to konosuba on wcostream looks like another show/);

    await svc.linkIsRight({ slug: 'konosuba' });
    expect((await svc.followed()).find((x) => x.slug === 'konosuba')!.linkWrong).toBeUndefined();
    (svc as any).jobs = [];
    expect((await svc.nightlyPlan()).length).toBe(1);                // checked no more: planned as usual
  });

  it('counts a dead video once a night, and on the second night hands the episode to Sonarr instead of more tries', async () => {
    const svc = new FillService((service as any).config);
    await svc.setFollow({ slug: 're-zero', seriesId: 575, follow: true, language: 'dub' });
    await (svc as any).markDead('re-zero', 101); await (svc as any).markDead('re-zero', 101);
    expect((await (svc as any).prefs())['re-zero'].tries[101].dead.n).toBe(1);   // same night: once
    await (svc as any).changePrefs((p: any) => { p['re-zero'].tries[101] = { n: 1, last: '2021-02-01T00:00:00Z', dead: { n: 2, day: 'Sun Feb 01 2021' } }; });
    await svc.setPaused(true);
    const made = await svc.nightlyPlan();
    expect(made.flatMap((j) => j.episodes.map((e) => e.id))).not.toContain(101);
    expect(calls.filter((c) => c.data?.name === 'EpisodeSearch').map((c) => c.data.episodeIds)).toEqual([[101]]);
    expect((await (svc as any).prefs())['re-zero'].tries[101].handedToSonarr).toBe(true);
    expect((svc as any).nightNotes.join('\n')).toMatch(/2x14: its video could not be had on two nights, handed to Sonarr/);
  });

  it('searches for the newest handed-over episodes only, up to the nightly cap', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { newestIds } = require('./fill.service');
    const got = newestIds([[{ id: 1, a: '2020-01-01' }, { id: 2, a: '2024-05-01' }], [{ id: 3, a: '2026-11-01' }, { id: 4 }]], 2);
    expect([...got].sort()).toEqual([2, 3]);
  });

  it('a run someone started reads the list again before refusing an episode the kept list does not have', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildListing } = require('./wco-episodes.util');
    const W = 'https://www.wcostream.tv/';
    const old = buildListing([W + 're-zero-season-2-episode-15-english-dubbed']);
    const now = buildListing([W + 're-zero-season-2-episode-14-english-dubbed', W + 're-zero-season-2-episode-15-english-dubbed']);
    const listing = jest.fn((slug: string, lang: string, fresh?: boolean) => Promise.resolve(fresh ? now : old));
    (service as any).wco = { peek: () => now, listing };
    const job = await run([101], { file: 'Re Zero-S02E14-English Dubbed.mp4' });
    expect(job.episodes[0].state).toBe('done');
    expect(listing.mock.calls.filter((c) => c[2] === true).length).toBe(1);
  });

  it('counts old downloads in staging and deletes only those', async () => {
    const stage = path.join(dir, 'out', 'wco-gaps', 're-zero-dub');
    const old = path.join(stage, 'S02E14'), fresh = path.join(stage, 'S02E15'), empty = path.join(stage, 'S02E16');
    await fs.mkdir(old, { recursive: true }); await fs.mkdir(fresh, { recursive: true }); await fs.mkdir(empty, { recursive: true });
    await fs.writeFile(path.join(old, 'Re Zero-S02E14.mp4'), 'x'.repeat(1000));
    await fs.writeFile(path.join(old, 'downloader.log'), 'log');
    await fs.writeFile(path.join(fresh, 'Re Zero-S02E15.mp4'), 'x'.repeat(500));
    const month = new Date(Date.now() - 30 * 86400000);
    for (const f of ['Re Zero-S02E14.mp4', 'downloader.log']) await fs.utimes(path.join(old, f), month, month);

    const s = await service.staging();
    expect(s).toMatchObject({ files: 2, bytes: 1500, days: 14, old: { folders: 1, files: 1, bytes: 1000 } });
    expect(await service.clearStaging()).toEqual({ folders: 1, bytes: 1000 });
    expect(await fs.readdir(stage)).toEqual(['S02E15']);
    expect((await service.staging()).old.folders).toBe(0);
  });

  it('"Fill now" plans runs that start at any hour, while overnight runs wait for the night', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { mayRun, isNight } = require('./fill.service');
    const svc = new FillService((service as any).config);
    await svc.setFollow({ slug: 're-zero', seriesId: 575, follow: true, language: 'dub' });
    await svc.setPaused(true);                                        // planned, not downloaded
    const made = await svc.nightlyPlan({ now: true });
    expect(made.length).toBeGreaterThan(0);
    for (const j of made) { expect(j).toMatchObject({ auto: true, now: true }); expect(mayRun(j)).toBe(true); }
    expect(mayRun({ ...made[0], now: undefined })).toBe(isNight());
    expect(mayRun({ ...made[0], auto: false, now: undefined })).toBe(true);
  });

  // 19 Nov 2026: refused shows were parked past 07:00, the night's runs never all finished, and no summary was written.
  it('tells the night at its close with parked episodes waiting, and tells each of them once when it finishes', async () => {
    const svc = new FillService((service as any).config);
    const push = jest.fn().mockResolvedValue(undefined);
    Object.assign(svc as any, { push, attention: async () => [], staging: async () => ({ old: { files: 0 } }), checkDisk: async () => ({ low: false }) });
    const at = new Date(Date.now() - 3600000).toISOString();
    const refused = "Not downloaded: wcostream's video server returned HTTP 404 (text/html) instead of a video.";
    const job: any = { id: 'n1', seriesId: 1, title: 'Hercules', slug: 'hercules', quality: '1080', absolute: false, createdAt: at, auto: true, episodes: [
      { id: 1, s: 1, e: 1, title: 'a', mode: 'missing', state: 'done' },
      { id: 2, s: 1, e: 2, title: 'b', mode: 'missing', state: 'failed', message: refused },
      { id: 3, s: 1, e: 3, title: 'c', mode: 'missing', state: 'queued' },
    ] };
    (svc as any).jobs = [job];
    await (svc as any).notifyNight();
    let r = (await svc.getLastRun())!;
    expect(r).toMatchObject({ tally: { filled: 1, failed: 1 }, waiting: 1, reasons: { refused: 1 } });
    expect(r.shows[0].why).toEqual({ refused: 1 });
    expect(push.mock.calls[0][1]).toMatch(/Why: 1 refused by the video server\.\n1 wait for the next night/);
    job.episodes[2].state = 'done';                                   // the parked one, the next night
    await (svc as any).notifyNight();
    r = (await svc.getLastRun())!;
    expect(r).toMatchObject({ tally: { filled: 1, failed: 0 }, waiting: 0 });
  });

  // 21 Nov 2026: FlareSolverr had stopped; every show page was a 403 block page and 274 episodes failed as "not listed".
  it('tells a block page from an episode wcostream does not list', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { failureKind, NOT_LISTED, BLOCKED } = require('./fill.service');
    const blocked = 'Not downloaded: No episodes found on milo-murphys-law (HTTP 403).';
    expect(failureKind(blocked)).toBe('blocked');
    expect(NOT_LISTED.test(blocked)).toBe(false);
    expect(BLOCKED.test('Byparr request to http://host.docker.internal:8191 for https://www.wcostream.tv/anime/x failed: connect ECONNREFUSED 192.168.65.254:8191')).toBe(true);
    expect(NOT_LISTED.test('Not downloaded: No episodes found on chip-n-dale-park-life (HTTP 200).')).toBe(true);   // a real empty list
  });

  it('holds the queue while wcostream cannot be read, and runs it once a read works', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { WcoHealth } = require('./wco-health');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildListing } = require('./wco-episodes.util');
    const health = new WcoHealth();
    for (let i = 0; i < 5; i++) health.record('error', 'connect ECONNREFUSED 192.168.65.254:8191');
    let reads = 0;
    const wco = { health, peek: () => undefined, listing: jest.fn(async () => { reads++; health.record('error', 'still down'); return undefined; }) };
    const svc = new FillService((service as any).config, wco as any);
    const fill = jest.spyOn(svc as any, 'fillOne').mockImplementation(async (_j: any, e: any) => { e.state = 'done'; });
    (svc as any).jobs = [{ id: 'h1', seriesId: 575, title: 'Re: ZERO', slug: 're-zero', quality: '1080', absolute: false, createdAt: new Date().toISOString(),
      episodes: [{ id: 101, s: 2, e: 14, title: 'x', mode: 'missing', state: 'queued' }] }];
    await (svc as any).pump();
    expect(fill).not.toHaveBeenCalled();
    expect(reads).toBe(1);                                             // one probe...
    await (svc as any).pump();
    expect(reads).toBe(1);                                             // ...at most every ten minutes
    wco.listing.mockImplementation(async () => { health.record('ok'); return buildListing([]); });
    (svc as any).probedAt = 0;
    await (svc as any).pump();
    expect(fill).toHaveBeenCalledTimes(1);
    expect((svc as any).jobs[0].episodes[0].state).toBe('done');
  });

  // 21 Nov 2026: Sonarr keeps JoJo and Pokémon as one series in many seasons; wcostream has a show per part, numbered from 1.
  it('a link set to one Sonarr season plans only that season, numbered from 1', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildListing } = require('./wco-episodes.util');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { seasonView } = require('./fill.service');
    expect(seasonView([{ id: 1, s: 1, e: 1, abs: 1 }, { id: 2, s: 2, e: 14, abs: 39 }, { id: 3, s: 2, e: 15, abs: 40 }], 2))
      .toEqual([{ id: 2, s: 2, e: 14, abs: 14 }, { id: 3, s: 2, e: 15, abs: 15 }]);
    const wco = { peek: () => undefined, listing: jest.fn().mockResolvedValue(buildListing([14, 15, 16].map((n) => `https://www.wcostream.tv/re-zero-part-two-episode-${n}-english-dubbed`))) };
    const svc = new FillService((service as any).config, wco as any);
    await svc.setFollow({ slug: 're-zero-part-two', seriesId: 575, follow: true, language: 'dub' });
    await svc.linkIsRight({ slug: 're-zero-part-two' });
    expect(await svc.setSeason({ slug: 're-zero-part-two', season: 2 })).toEqual({ slug: 're-zero-part-two', season: 2, absolute: true });
    await svc.setPaused(true);
    const made = await svc.nightlyPlan();
    const job = made.find((j) => j.slug === 're-zero-part-two')!;
    expect(job).toMatchObject({ season: 2, absolute: true });
    expect(job.episodes.map((e) => [e.id, e.abs])).toEqual([[101, 14], [102, 15]]);   // 2x14 is the site's 14; 2x15 swaps to the dub
    await expect(svc.setSeason({ slug: 're-zero-part-two', season: 0 })).rejects.toThrow(/whole number/);
    expect(await svc.setSeason({ slug: 're-zero-part-two', season: null })).toMatchObject({ season: null, absolute: false });
  });

  it('starts the held queue as soon as any read works again', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { WcoHealth } = require('./wco-health');
    const health = new WcoHealth();
    const svc = new FillService((service as any).config, { health, peek: () => undefined, listing: jest.fn() } as any);
    (svc as any).jobs = [];
    (svc as any).pump = async () => undefined;
    await svc.onApplicationBootstrap();
    const pump = jest.spyOn(svc as any, 'pump').mockResolvedValue(undefined);
    jest.spyOn(svc as any, 'tellWco').mockResolvedValue(undefined);
    for (let i = 0; i < 5; i++) health.record('error', 'connect ECONNREFUSED 192.168.65.254:8191');
    expect(pump).not.toHaveBeenCalled();
    health.record('ok');                                              // a page read on the map, say
    expect(pump).toHaveBeenCalledTimes(1);
  });

  // 22 Nov 2026: 17 followed shows had a second folder Sonarr does not track; their episodes were downloaded again.
  it('lists a second folder\'s files with the episode each would be, and imports only into episodes with no file', async () => {
    const svc = new FillService((service as any).config);
    (svc as any).splitFolders = async () => new Map([[575, ['E:/TV/Re Zero (old)']]]);
    const sent: any[] = [];
    (svc as any).mapEpisodes = async () => [                           // 2x14 has a file once the import was sent
      { id: 101, s: 2, e: 14, t: 'Straight Bet', st: sent.length ? 'dub' : 'missing' }, { id: 102, s: 2, e: 15, t: 'Otto Suwen', st: 'undub' },
      { id: 103, s: 2, e: 16, t: 'Bonds of Lust', st: sent.length ? 'dub' : 'missing' }];
    (svc as any).sonarr = jest.fn(async (method: string, url: string, data?: any) => {
      if (url.startsWith('series/')) return { id: 575, path: 'E:/TV/Re Zero' };
      if (url.startsWith('manualimport?')) { expect(url).not.toMatch(/seriesId/); }   // given a series, Sonarr scans its own folder instead
      if (url.startsWith('manualimport?')) return [
        { path: 'E:/TV/Re Zero/Season 2/Re Zero - 2x14.mkv', folderName: 'Season 2', quality: { q: 1 }, episodes: [{ id: 101 }] },   // Sonarr's own file: never offered
        { path: 'E:/TV/Re Zero (old)/Re Zero - 2x14.mkv', folderName: 'Re Zero (old)', quality: { q: 1 }, episodes: [{ id: 101 }] },
        { path: 'E:/TV/Re Zero (old)/Re Zero - 2x15.mkv', folderName: 'Re Zero (old)', quality: { q: 1 }, episodes: [{ id: 102 }] },
        { path: 'E:/TV/Re Zero (old)/notes.txt', episodes: [] },
        { path: 'E:/TV/Re Zero (old)/Extra.mp4', episodes: [] },
        { path: 'E:/TV/Re Zero (old)/Rezero-S02E14-English Dubbed.mp4', folderName: 'Re Zero (old)', episodes: [] },
        { path: 'E:/TV/Re Zero (old)/Rezero-S02E16-English Dubbed.mp4', folderName: 'Re Zero (old)', episodes: [] }];
      if (url === 'command') { sent.push(data); return { id: 9 }; }
      if (url.startsWith('command/')) return { status: 'completed' };
      return {};
    });
    const files = await svc.splitFiles(575);
    expect(files.map((f) => [f.name, f.ok, f.why])).toEqual([
      ['Re Zero - 2x14.mkv', true, ''], ['Re Zero - 2x15.mkv', false, 'that episode has a file already'], ['Extra.mp4', false, 'Sonarr cannot tell which episode this is'],
      ['Rezero-S02E14-English Dubbed.mp4', false, 'another file here is that episode'],   // one file per episode
      ['Rezero-S02E16-English Dubbed.mp4', true, '']]);                     // placed by its SxxEyy when Sonarr cannot
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: any) => { fn(); return 0 as any; }) as any);
    const r = await svc.importSplit({ seriesId: 575, paths: files.map((f) => f.path) });
    (global.setTimeout as any).mockRestore?.();
    expect(r).toMatchObject({ imported: 2, asked: 2, status: 'completed' });
    expect(sent[0]).toMatchObject({ name: 'ManualImport', importMode: 'move', files: [{ path: 'E:/TV/Re Zero (old)/Re Zero - 2x14.mkv', seriesId: 575, episodeIds: [101] },
      { path: 'E:/TV/Re Zero (old)/Rezero-S02E16-English Dubbed.mp4', seriesId: 575, episodeIds: [103] }] });
    await expect(svc.importSplit({ seriesId: 575, paths: [] })).rejects.toThrow(/Pick the files/);
  });

  it('clears from Needs you what is not on wcostream and already with Sonarr, or three days old; keeps the rest', async () => {
    const svc = new FillService((service as any).config);
    (svc as any).mapEpisodes = async () => [];
    await (svc as any).changePrefs((p: any) => { p.nyshow = { seriesId: 575, tries: { 1: { n: 1, last: '', handedToSonarr: true } } }; });
    const old = new Date(Date.now() - 4 * 86400000).toISOString(), recent = new Date().toISOString();
    const unlisted = 'Not downloaded: wcostream does not list this episode under this season and number';
    (svc as any).jobs = [
      { id: 'a', seriesId: 575, title: 'S', slug: 'nyshow', createdAt: recent, finishedAt: recent, episodes: [
        { id: 1, s: 1, e: 1, title: 'handed', mode: 'missing', state: 'failed', message: unlisted },
        { id: 2, s: 1, e: 2, title: 'recent', mode: 'missing', state: 'failed', message: unlisted },
        { id: 3, s: 1, e: 3, title: 'refused', mode: 'missing', state: 'failed', message: "Not downloaded: wcostream's video server returned HTTP 404 (text/html) instead of a video." }] },
      { id: 'b', seriesId: 575, title: 'S', slug: 'nyshow', createdAt: old, finishedAt: old, episodes: [
        { id: 4, s: 1, e: 4, title: 'old', mode: 'missing', state: 'failed', message: unlisted }] },
    ];
    expect((await svc.attention()).map((a) => a.title).sort()).toEqual(['recent', 'refused']);
  });

  it('never plans a swap for a show set to "no dialogue", and counts no undubbed for it', async () => {
    const svc = new FillService((service as any).config);
    await svc.setFollow({ slug: 're-zero', seriesId: 575, follow: true, language: 'dub' });
    expect(await svc.setNoSwap({ slug: 're-zero', noSwap: true })).toEqual({ slug: 're-zero', noSwap: true });
    await svc.setPaused(true);
    const made = await svc.nightlyPlan();
    expect(made.flatMap((j) => j.episodes).some((e) => e.mode === 'swap')).toBe(false);
    expect((await svc.followed()).find((x) => x.slug === 're-zero')).toMatchObject({ undub: 0, noSwap: true });
    await svc.setNoSwap({ slug: 're-zero', noSwap: false });
  });

  it('hands a whole show to Sonarr: monitors the series and its missing episodes, searches, and stops following', async () => {
    const svc = new FillService((service as any).config);
    await svc.setFollow({ slug: 'gone-show', seriesId: 575, follow: true, language: 'dub' });
    const r = await svc.handShowToSonarr({ slug: 'gone-show' });
    expect(r).toMatchObject({ slug: 'gone-show', monitored: 1, searched: 1 });
    expect(calls.find((c) => c.data?.name === 'EpisodeSearch')!.data.episodeIds).toEqual([101]);
    expect((await (svc as any).prefs())['gone-show'].follow).toBe(false);
  });

  // 22 Nov 2026: 350 followed shows; new weekly episodes were buried behind backlogs, and dead shows failed nightly.
  it('says a show is dead when five episodes had dead nights and nothing downloaded in a week', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { showVideosDead } = require('./fill.service');
    const map = [1, 2, 3, 4, 5, 6].map((id) => ({ id }));
    const tries: any = {}; for (const id of [1, 2, 3, 4, 5]) tries[id] = { n: 1, last: '', dead: { n: 1, day: 'x' } };
    const now = Date.now(), recent = new Date(now - 86400000).toISOString();
    expect(showVideosDead(map, tries, [{ createdAt: recent, episodes: [{ state: 'failed' }] }] as any, now)).toBe(true);
    expect(showVideosDead(map, tries, [{ createdAt: recent, episodes: [{ state: 'done' }] }] as any, now)).toBe(false);   // something came through
    delete tries[5];
    expect(showVideosDead(map, tries, [], now)).toBe(false);                                                               // only four
  });

  it('hands a dead show to Sonarr whole and rests it', async () => {
    const svc = new FillService((service as any).config);
    await svc.setFollow({ slug: 'dead-show', seriesId: 575, follow: true, language: 'dub' });
    const eps = [1, 2, 3, 4, 5, 6].map((n) => ({ id: 900 + n, s: 1, e: n, t: 'x', a: '2020-01-0' + n, st: 'missing' }));
    (svc as any).mapEpisodes = async () => eps;
    await (svc as any).changePrefs((p: any) => {
      p['dead-show'].tries = {};
      for (const e of eps.slice(0, 5)) p['dead-show'].tries[e.id] = { n: 1, last: '2026-11-20T01:00:00Z', dead: { n: 1, day: 'x' } };
    });
    (svc as any).jobs = [];
    await svc.setPaused(true);
    expect(await svc.nightlyPlan()).toEqual([]);                       // nothing queued for it
    const search = calls.filter((c) => c.data?.name === 'EpisodeSearch').pop();
    expect(search!.data.episodeIds.sort()).toEqual(eps.map((e) => e.id));   // all six missing go to Sonarr
    const pref = (await (svc as any).prefs())['dead-show'];
    expect(new Date(pref.deadUntil).getTime()).toBeGreaterThan(Date.now() + 13 * 86400000);
    expect((await svc.followed()).find((x) => x.slug === 'dead-show')!.resting).toBe(pref.deadUntil);
    expect(await svc.nightlyPlan()).toEqual([]);                       // resting: not looked at again
  });

  it('plans a show with new episodes before backlogs, and its new episodes first', async () => {
    const svc = new FillService((service as any).config);
    const day = (d: number) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    await (svc as any).changePrefs((p: any) => {
      for (const k of Object.keys(p)) p[k].follow = false;
      p.backlog = { seriesId: 1, title: 'Backlog', follow: true, language: 'dub', tries: {} };
      p.weekly = { seriesId: 2, title: 'Weekly', follow: true, language: 'dub', tries: {} };
    });
    (svc as any).mapEpisodes = async (id: number) => id === 1
      ? [{ id: 11, s: 1, e: 1, t: 'a', a: '2010-01-01', st: 'missing' }]
      : [3, 2, 1].map((n) => ({ id: 20 + n, s: 1, e: n, t: 'b', a: n === 3 ? day(2) : n === 2 ? day(9) : '2011-01-01', st: 'missing' }));
    const order: any[] = [];
    (svc as any).createJob = async (b: any) => { order.push([b.slug, b.episodeIds]); return { episodes: b.episodeIds.map((id: number) => ({ id })) }; };
    await svc.nightlyPlan();
    expect(order).toEqual([['weekly', [23, 22, 21]], ['backlog', [11]]]);   // newest first, though it has more due
  });

  it('reports how many handed-over episodes Sonarr found, from one to eight weeks back', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { handoffReport } = require('./fill.service');
    const now = Date.now(), d = (n: number) => new Date(now - n * 86400000).toISOString();
    const h = { 1: { slug: 'a', title: 'A', at: d(10), found: d(3) }, 2: { slug: 'a', title: 'A', at: d(20) },
      3: { slug: 'b', title: 'B', at: d(2) }, 4: { slug: 'b', title: 'B', at: d(90), found: d(80) } };
    expect(handoffReport(h, now)).toEqual({ handed: 2, found: 1 });   // 3 is too new, 4 too old
    expect(handoffReport({}, now)).toBeUndefined();
  });

  it('notes in the log when Sonarr has found a handed-over episode', async () => {
    const svc = new FillService((service as any).config);
    await svc.setFollow({ slug: 're-zero', seriesId: 575, follow: true, language: 'dub' });
    await (svc as any).handoffs().update((h: any) => { h[103] = { slug: 're-zero', title: 'Re: ZERO', at: new Date().toISOString() }; });
    await svc.setPaused(true);
    await svc.nightlyPlan();                                          // 2x16 (103) has a file in the fixture
    expect((await (svc as any).handoffs().read())[103].found).toBeTruthy();
  });

  it('names why an episode failed, in a word', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { failureKind } = require('./fill.service');
    expect(failureKind("Not downloaded: wcostream's video server returned HTTP 404 (text/html) instead of a video.")).toBe('refused');
    expect(failureKind('Not downloaded: Could not find a video for x: No video player iframe found on x')).toBe('no-player');
    expect(failureKind('Not downloaded: wcostream does not list this episode under this season and number')).toBe('unlisted');
    expect(failureKind('Downloaded Happy The Hoglet-S01E01-0.mp4, which is not 1x10; left in staging')).toBe('misnamed');
    expect(failureKind('The download stalled (no output for a while)')).toBe('stalled');
  });

  it('checks every followed show\'s link behind the screen, flags another show, and queues nothing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildListing } = require('./wco-episodes.util');
    const wco = { peek: () => undefined, listing: jest.fn().mockResolvedValue(buildListing([14, 15, 16].map((n) => `https://www.wcostream.tv/konosuba-season-2-episode-${n}-english-dubbed`))) };
    const svc = new FillService((service as any).config, wco as any);
    (svc as any).seriesCache = { at: Date.now(), list: [{ id: 575, title: 'Re: ZERO', titleSlug: 're-zero' }] };
    await (svc as any).changePrefs((p: any) => { p.konosuba = { seriesId: 575, title: 'Re: ZERO', follow: true, language: 'dub' }; });
    expect(svc.checkLinks()).toMatchObject({ started: true });
    await (svc as any).linkQueue;
    const prefs = await (svc as any).prefs();
    expect(prefs.konosuba.linkWrong.why).toMatch(/name on wcostream is not one of the show's names/);
    expect((svc as any).jobs).toEqual([]);
    expect(svc.linkProgress()).toBeUndefined();                        // finished
  });

  it('keeps a line per finished attempt, with why it failed', async () => {
    await (service as any).logAttempt({ slug: 're-zero', title: 'Re: ZERO', seriesId: 575, auto: true },
      { id: 101, s: 2, e: 14, mode: 'missing', state: 'failed', message: "Not downloaded: wcostream's video server returned HTTP 404 (text/html) instead of a video." });
    await (service as any).logAttempt({ slug: 're-zero', title: 'Re: ZERO', seriesId: 575 }, { id: 102, s: 2, e: 15, mode: 'swap', state: 'queued' });
    const lines = (await fs.readFile(path.join((service as any).config.configDir, 'fill-attempts.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ slug: 're-zero', id: 101, state: 'failed', kind: 'refused', auto: true });
  });

  it('keeps the summary of the automatic runs, sends only an overnight one, and never counts a run twice', async () => {
    const svc = new FillService((service as any).config);
    const push = jest.fn().mockResolvedValue(undefined);
    Object.assign(svc as any, { push, attention: async () => [], staging: async () => ({ old: { files: 0 } }), checkDisk: async () => ({ low: false }) });
    const ep = (id: number, state: string, mode = 'missing') => ({ id, s: 1, e: id, title: 'x', mode, state });
    const job = (id: string, seriesId: number, title: string, createdAt: string, episodes: any[], now?: boolean) =>
      ({ id, seriesId, title, slug: title.toLowerCase(), quality: '1080', absolute: false, createdAt, auto: true, now, episodes });
    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    (svc as any).jobs = [
      job('a', 1, 'Bravo', hourAgo, [ep(1, 'done'), ep(2, 'failed')], true),
      job('b', 2, 'alpha', hourAgo, [ep(3, 'done', 'swap'), ep(4, 'cancelled')], true),
      job('z', 9, 'Old', new Date(Date.now() - 30 * 3600000).toISOString(), [ep(9, 'done')]),   // over 20 hours ago
    ];
    await (svc as any).notifyNight();
    const first = (await svc.getLastRun())!;
    expect(first).toMatchObject({ kind: 'now', tally: { filled: 1, swapped: 1, failed: 1, premium: 0, kept: 0 }, attention: 0 });
    expect(first.shows.map((s) => [s.title, s.slug, s.filled + s.swapped, s.failed])).toEqual([['alpha', 'alpha', 1, 0], ['Bravo', 'bravo', 1, 1]]);
    expect(push).not.toHaveBeenCalled();                              // "Fill now": the person is looking at the screen

    await (svc as any).notifyNight();                                 // nothing new since: nothing written, nothing sent
    expect((await svc.getLastRun())!.at).toBe(first.at);

    (svc as any).jobs.push(job('c', 3, 'Charlie', new Date(Date.now() + 1000).toISOString(), [ep(5, 'premium')]));
    await (svc as any).notifyNight();
    expect(await svc.getLastRun()).toMatchObject({ kind: 'night', tally: { premium: 1, filled: 0, swapped: 0 } });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toBe('wco-dl overnight');
    expect(push.mock.calls[0][1]).toMatch(/^Overnight: 0 filled, 0 swapped to dub, 1 premium to Sonarr/);
    expect((await new FillService((service as any).config).getLastRun())!.kind).toBe('night');   // kept over a restart
  });

  it('a parked overnight run names the next night, not a time outside the window', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { brakeMessage } = require('./fill.service');
    expect(brakeMessage(5, new Date(2026, 10, 13, 7, 35), true)).toMatch(/the rest wait for the next overnight run$/);
    expect(brakeMessage(5, new Date(2026, 10, 13, 3, 5), true)).toMatch(/the rest wait until 03:05$/);
    expect(brakeMessage(5, new Date(2026, 10, 13, 17, 40), false)).toMatch(/the rest wait until 17:40$/);
  });

  it('checks settings and runs a window past midnight', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { cleanSettings, isNight, NIGHT } = require('./fill.service');
    expect(cleanSettings({ nightFrom: 23, nightTo: 6, nightBudget: 60, quality: '480' })).toEqual({ nightFrom: 23, nightTo: 6, nightBudget: 60, quality: '480' });
    expect(cleanSettings({ nightFrom: 3, nightTo: 3, nightBudget: 0, quality: '4k', dubToken: 'x' })).toEqual({});
    expect(cleanSettings({ nightFrom: 24, nightTo: 6, nightBudget: '50' })).toEqual({ nightBudget: 50 });
    const was = { ...NIGHT };
    try {
      NIGHT.from = 23; NIGHT.to = 6;
      expect(isNight(new Date(2026, 10, 12, 23, 30))).toBe(true);
      expect(isNight(new Date(2026, 10, 12, 5, 59))).toBe(true);
      expect(isNight(new Date(2026, 10, 12, 6, 0))).toBe(false);
      expect(isNight(new Date(2026, 10, 12, 12, 0))).toBe(false);
    } finally { NIGHT.from = was.from; NIGHT.to = was.to; }
  });

  it('names an episode wcostream does not list, and never shows a video token', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { failureReason, NOT_LISTED, VIDEO_REFUSED } = require('./fill.service');
    const gone = failureReason('Threads started\nError: list index out of range\nError: list index out of range\n[wco-dl] - 0 episode(s) downloaded, 0 premium-only skipped.');
    expect(gone).toBe('Not downloaded: wcostream does not list this episode under this season and number');
    expect(require('./fill.service').NOT_LISTED.test(gone)).toBe(true);   // so no second attempt is wasted on it
    const said = failureReason('[wco-dl] - No episode matches season 1 episode 23: wcostream lists 60 episode(s) for this show, numbered differently or without this one.\n[wco-dl] - 1 episode(s) failed to download.');
    expect(NOT_LISTED.test(said)).toBe(true);
    expect(said).toContain('season 1 episode 23: wcostream lists 60');
    const refused = failureReason('[wco-dl] - https://m01.wcostream.com/getvid?evid=' + 'aB3'.repeat(90) + ' returned HTTP 404 (text/html) instead of a video.');
    expect(refused).toBe("Not downloaded: wcostream's video server returned HTTP 404 (text/html) instead of a video.");
    expect(VIDEO_REFUSED.test(refused)).toBe(true);
  });

  it('names a refused video and matches the brake pattern', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { failureReason, VIDEO_REFUSED } = require('./fill.service');
    const text = '[wco-dl] - https://m01.wcostream.com/getvid?evid=abc returned HTTP 404 (text/html) instead of a video.\n' +
      '[wco-dl] - Download for Hercules-S02E01 did not complete, please create an issue on GitHub.\n[wco-dl] - 1 episode(s) failed to download.';
    expect(failureReason(text)).toMatch(/returned HTTP 404 \(text\/html\) instead of a video/);
    expect(VIDEO_REFUSED.test(failureReason(text))).toBe(true);
    expect(VIDEO_REFUSED.test('Not downloaded: Could not find a video for x: No video player iframe found')).toBe(false);
  });

  it('keeps an automatic run waiting outside the night window', async () => {
    jest.spyOn(require('./fill.service'), 'isNight');
    const job = await service.createJob({ seriesId: 575, slug: 're-zero', language: 'dub', episodeIds: [101], auto: true });
    await new Promise((r) => setTimeout(r, 300));
    const hour = new Date().getHours();
    expect(job.episodes[0].state).toBe(hour >= 1 && hour < 7 ? job.episodes[0].state : 'queued');
  });

  it('imports a complete file already in staging (the downloader skips it)', async () => {
    const staged = path.join(dir, 'out', 'wco-gaps', 're-zero-dub', 'S02E14');
    await fs.mkdir(staged, { recursive: true });
    await fs.writeFile(path.join(staged, 'Re Zero-S02E14-English Dubbed.mp4'), 'x');
    const job = await run([101], { skip: true });   // the downloader checks the size and skips it
    expect(job.episodes[0].state).toBe('done');
  });
});

describe('nightly schedule rules', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { retryDue, isNight } = require('./fill.service');
  const at = (s: string) => new Date(s);
  it('waits a day after airing, then backs off 3, 7 and 14 days, then gives up', () => {
    expect(retryDue('2026-11-10', undefined, at('2026-11-10T20:00:00Z'))).toBe('wait');
    expect(retryDue('2026-11-10', undefined, at('2026-11-11T13:00:00Z'))).toBe('due');
    expect(retryDue('2026-11-10', { n: 1, last: '2026-11-11T01:05:00Z' }, at('2026-11-13T01:05:00Z'))).toBe('wait');
    expect(retryDue('2026-11-10', { n: 1, last: '2026-11-11T01:05:00Z' }, at('2026-11-14T01:06:00Z'))).toBe('due');
    expect(retryDue('2026-11-10', { n: 4, last: '2026-11-30T01:05:00Z' }, at('2027-01-01T01:05:00Z'))).toBe('give-up');
  });
  it('treats 01:00 to 06:59 local time as night', () => {
    expect(isNight(new Date(2026, 10, 12, 1, 0))).toBe(true);
    expect(isNight(new Date(2026, 10, 12, 6, 59))).toBe(true);
    expect(isNight(new Date(2026, 10, 12, 7, 0))).toBe(false);
    expect(isNight(new Date(2026, 10, 11, 21, 30))).toBe(false);
  });
});

describe('FillService start-up', () => {
  it('requeues interrupted episodes and cancels duplicates', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fillboot-'));
    const ep = (id: number, state: string) => ({ id, s: 1, e: id, title: 't', mode: 'missing', state });
    const jobs = [
      { id: 'a', seriesId: 1, title: 'x', slug: 'x', quality: '1080', absolute: false, createdAt: '1', episodes: [ep(1, 'downloading'), ep(2, 'queued')] },
      { id: 'b', seriesId: 1, title: 'x', slug: 'x', quality: '1080', absolute: false, createdAt: '2', episodes: [ep(2, 'queued'), ep(3, 'queued'), ep(1, 'queued')] },
    ];
    await fs.mkdir(path.join(dir, 'config'), { recursive: true });
    await fs.writeFile(path.join(dir, 'config', 'fill-jobs.json'), JSON.stringify(jobs));
    const svc = new FillService({ configDir: path.join(dir, 'config') } as unknown as AppConfig);
    (svc as any).running = true;   // do not start the worker
    await svc.onApplicationBootstrap();
    const [b, a] = svc.listJobs();
    expect(a.episodes.map((e) => e.state)).toEqual(['queued', 'queued']);
    expect(a.episodes[0].message).toMatch(/Resumed/);
    expect(b.episodes.map((e) => e.state)).toEqual(['cancelled', 'queued', 'cancelled']);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
});

describe('FillService start-up after wcostream could not be read', () => {
  it('queues again the episodes that failed only on a block page, and leaves real failures', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blocked-'));
    const now = new Date().toISOString();
    await fs.writeFile(path.join(dir, 'fill-jobs.json'), JSON.stringify([{ id: 'b1', seriesId: 1, title: 'Milo', slug: 'milo', quality: '1080', absolute: false, createdAt: now, auto: true, told: [1, 2],
      episodes: [
        { id: 1, s: 1, e: 1, title: 'a', mode: 'missing', state: 'failed', message: 'Not downloaded: No episodes found on milo (HTTP 403).' },
        { id: 2, s: 1, e: 2, title: 'b', mode: 'missing', state: 'failed', message: "Not downloaded: wcostream's video server returned HTTP 404 (text/html) instead of a video." },
      ] }]));
    const svc = new FillService({ configDir: dir, outputBase: path.join(dir, 'out') } as unknown as AppConfig);
    (svc as any).pump = async () => undefined;
    await svc.onApplicationBootstrap();
    const eps = (svc as any).jobs[0].episodes;
    expect(eps[0]).toMatchObject({ state: 'queued', message: 'Queued again: wcostream could not be read when it ran' });
    expect(eps[1].state).toBe('failed');
    expect((svc as any).jobs[0].told).toEqual([2]);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
});

describe('FillService without Sonarr', () => {
  it('answers the map screens without crashing when SONARR_API_KEY is not set', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fillnosonarr-'));
    const unhandled: unknown[] = [];
    const onRejection = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onRejection);
    try {
      const svc = new FillService({ configDir: path.join(dir, 'config'), sonarrUrl: 'http://sonarr' } as unknown as AppConfig);
      await expect(svc.splitFolders()).resolves.toEqual(new Map());
      await expect(svc.followed()).resolves.toEqual([]);
      await new Promise((r) => setTimeout(r, 50));   // let any stray rejection surface
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});

describe('failure messages', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { failureReason } = require('./fill.service');
  it("gives the downloader's own reason, not its summary", () => {
    const out = '[wco-dl] - Waiting 11s for the embed ad gate...\n[wco-dl] - Could not find a video for https://www.wcostream.tv/x-episode-10: Embed player returned HTTP 503: Servers Busy\n[wco-dl] - 0 episode(s) downloaded, 0 premium-only skipped.\n[wco-dl] - 1 episode(s) failed to download.';
    expect(failureReason(out)).toBe('Not downloaded: Could not find a video for x-episode-10: Embed player returned HTTP 503: Servers Busy');
  });
});

describe('show links and follows', () => {
  let dir: string;
  let prefsFile: string;
  let gate: Promise<void> | undefined;
  let planAsked: () => void;
  const config = () => ({ sonarrUrl: 'http://sonarr', sonarrApiKey: 'k', configDir: dir, outputBase: path.join(dir, 'out') } as unknown as AppConfig);
  const saved = async () => JSON.parse(await fs.readFile(prefsFile, 'utf8'));

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prefs-'));
    prefsFile = path.join(dir, 'show-prefs.json');
    gate = undefined;
    planAsked = () => undefined;
    jest.spyOn(axios, 'request').mockImplementation(async (req: any) => {
      const url = String(req.url).replace(/^.*\/api\/v3\//, '');
      if (url.startsWith('episode?seriesId')) { planAsked(); await gate; return { data: [] }; }
      if (url.startsWith('series/')) return { data: { id: Number(url.split('/')[1]), title: 'Show ' + url.split('/')[1] } };
      return { data: [] };
    });
  });
  afterEach(async () => { jest.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });

  it('keeps a follow made while the nightly plan is running', async () => {
    const svc = new FillService(config());
    await svc.setFollow({ slug: 'first-show', seriesId: 1, follow: true });
    let release!: () => void;
    gate = new Promise<void>((ok) => { release = ok; });
    const asked = new Promise<void>((ok) => { planAsked = ok; });
    const plan = svc.nightlyPlan();
    await asked;                          // the plan has read the list and is waiting for Sonarr
    await svc.setFollow({ slug: 'second-show', seriesId: 2, follow: true });
    release();
    await plan;
    const now = await saved();
    expect(now['second-show']?.follow).toBe(true);
    expect(now['first-show'].counts).toEqual(expect.objectContaining({ missing: 0, undub: 0 }));   // the plan's own work is kept too
  });

  it('runs one plan at a time: a second call joins the first', async () => {
    const svc = new FillService(config());
    await svc.setFollow({ slug: 'first-show', seriesId: 1, follow: true });
    const calls = () => (axios.request as jest.Mock).mock.calls.filter(([r]) => String(r.url).includes('episode?seriesId')).length;
    const before = calls();
    await Promise.all([svc.nightlyPlan(), svc.nightlyPlan()]);
    expect(calls() - before).toBe(1);
  });

  it('does not take a list cut short by a restart for "no shows"', async () => {
    const svc = new FillService(config());
    await svc.setFollow({ slug: 'first-show', seriesId: 1, follow: true });
    await svc.setFollow({ slug: 'second-show', seriesId: 2, follow: true });   // the copy from before now holds first-show
    await fs.writeFile(prefsFile, '{"first-show": {"seriesId"');
    expect((await svc.followed()).map((f) => f.slug)).toEqual(['first-show']);
    // With no copy to fall back on, the screens say so and nothing is written over the file.
    await fs.rm(prefsFile + '.bak');
    await fs.writeFile(prefsFile, '{"first-show": {"seriesId"');
    await expect(svc.followed()).rejects.toThrow(/cannot be read/);
    await expect(svc.setFollow({ slug: 'third-show', seriesId: 3, follow: true })).rejects.toThrow(/Nothing was changed/);
    expect(await fs.readFile(prefsFile, 'utf8')).toBe('{"first-show": {"seriesId"');
  });

  describe('the followed list and a slow Sonarr', () => {
    let seriesAsked: number;
    let release: () => void;
    let fail: boolean;
    const settled = async (svc: FillService) => { for (let i = 0; i < 200 && svc.followedRefreshing; i++) await new Promise((r) => setTimeout(r, 10)); };

    beforeEach(() => {
      seriesAsked = 0;
      fail = false;
      const held = new Promise<void>((r) => { release = r; });
      (axios.request as jest.Mock).mockImplementation(async (req: any) => {
        const url = String(req.url).replace(/^.*\/api\/v3\//, '');
        if (url === 'series') {
          seriesAsked++;
          await held;
          if (fail) throw new Error('connect ECONNREFUSED');
          return { data: [{ id: 1, title: 'Show 1', path: '/tv/Show 1', statistics: { episodeCount: 10, episodeFileCount: 7 } },
            { id: 2, title: 'Show 2', path: '/tv/Show 2', statistics: { episodeCount: 4, episodeFileCount: 4 } }] };
        }
        if (url.startsWith('series/')) return { data: { id: Number(url.split('/')[1]), title: 'Show ' + url.split('/')[1] } };
        if (url === 'rootfolder') return { data: [{ unmappedFolders: [{ name: 'Show 1', path: '/other/Show 1' }] }] };
        return { data: [] };
      });
    });

    it('answers at once from what it last knew, refreshes behind, and keeps the facts over a restart', async () => {
      const svc = new FillService(config());
      await svc.setFollow({ slug: 'first-show', seriesId: 1, follow: true });
      // Sonarr has not answered yet: the list comes back anyway, without the two facts only Sonarr has.
      const first = await svc.followed();
      expect(first.map((f) => [f.slug, f.missing, f.split])).toEqual([['first-show', undefined, []]]);
      expect(svc.followedRefreshing).toBe(true);
      release();
      await settled(svc);
      expect((await svc.followed()).map((f) => [f.missing, f.split])).toEqual([[3, ['/other/Show 1']]]);
      expect(svc.followedRefreshing).toBe(false);          // fresh: nothing more to wait for
      // A newly followed show is not in those facts yet: one more look at Sonarr, and the first show keeps its count meanwhile.
      await svc.setFollow({ slug: 'second-show', seriesId: 2, follow: true });
      expect((await svc.followed()).map((f) => f.missing)).toEqual([3, undefined]);
      await settled(svc);
      expect((await svc.followed()).map((f) => f.missing)).toEqual([3, 0]);
      // After a restart the facts come from disk: the full list with no call to Sonarr.
      const asked = seriesAsked;
      const again = new FillService(config());
      expect((await again.followed()).map((f) => [f.missing, f.split.length])).toEqual([[3, 1], [0, 0]]);
      expect(again.followedRefreshing).toBe(false);
      expect(seriesAsked).toBe(asked);
    });

    it('does not ask a Sonarr that is down again on every visit', async () => {
      fail = true;
      release();
      const svc = new FillService(config());
      await svc.setFollow({ slug: 'first-show', seriesId: 1, follow: true });
      const asked = seriesAsked;
      await expect(svc.followed()).resolves.toHaveLength(1);
      await settled(svc);
      await expect(svc.followed()).resolves.toHaveLength(1);
      await expect(svc.followed()).resolves.toHaveLength(1);
      expect(svc.followedRefreshing).toBe(false);
      expect(seriesAsked - asked).toBe(1);
    });
  });
});

describe('posters', () => {
  const config = (key?: string) => ({ sonarrUrl: 'http://sonarr', sonarrApiKey: key, configDir: os.tmpdir(), outputBase: os.tmpdir() } as unknown as AppConfig);
  afterEach(() => jest.restoreAllMocks());

  it("hands back Sonarr's small poster, asked for with the key the browser never sees", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const spy = jest.spyOn(axios, 'request').mockResolvedValue({ data: jpeg, headers: { 'content-type': 'image/jpeg' } } as any);
    const got = await new FillService(config('k')).poster(42);
    expect(got.type).toBe('image/jpeg');
    expect(Buffer.compare(got.data, jpeg)).toBe(0);
    const req = spy.mock.calls[0][0] as any;
    expect(req.url).toBe('http://sonarr/api/v3/mediacover/42/poster-250.jpg');
    expect(req.headers['X-Api-Key']).toBe('k');
    expect(req.responseType).toBe('arraybuffer');
  });

  it('answers 404 when there is no poster to give, and never asks Sonarr without a key or a real id', async () => {
    const spy = jest.spyOn(axios, 'request');
    await expect(new FillService(config()).poster(42)).rejects.toThrow('No poster');          // Sonarr not set up
    await expect(new FillService(config('k')).poster(NaN)).rejects.toThrow('No poster');      // "/poster/abc"
    await expect(new FillService(config('k')).poster(-1)).rejects.toThrow('No poster');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRejectedValueOnce(new Error('Request failed with status code 404'));              // Sonarr has no poster yet
    await expect(new FillService(config('k')).poster(42)).rejects.toThrow('No poster');
    spy.mockResolvedValueOnce({ data: Buffer.from('<html>sign in</html>'), headers: { 'content-type': 'text/html; charset=utf-8' } } as any);
    await expect(new FillService(config('k')).poster(42)).rejects.toThrow('No poster');       // a login page is not a picture
  });
});

describe('FillService: Sonarr series list for screens', () => {
  afterEach(() => jest.restoreAllMocks());

  it('gives the last list at once and refreshes it behind, waits only when there is none, and asks once at a time', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'series-'));
    try {
      let n = 0;
      jest.spyOn(axios, 'request').mockImplementation(async () => {
        const mine = ++n;
        await new Promise((r) => setTimeout(r, 60));
        return { data: [{ id: mine, title: `list ${mine}` }] };
      });
      const svc = new FillService({ sonarrUrl: 'http://sonarr', sonarrApiKey: 'k', configDir: dir } as unknown as AppConfig);
      const [a, b] = await Promise.all([svc.allSeriesNow(), svc.allSeries()]);
      expect(n).toBe(1);
      expect(a).toBe(b);

      (svc as any).seriesCache.at -= 10 * 60 * 1000;          // older than five minutes
      const t = Date.now();
      const stale = await svc.allSeriesNow();
      expect(Date.now() - t).toBeLessThan(40);
      expect(stale[0].title).toBe('list 1');
      expect(svc.seriesRefreshing).toBe(true);
      for (let i = 0; i < 100 && svc.seriesRefreshing; i++) await new Promise((r) => setTimeout(r, 10));
      expect((await svc.allSeriesNow())[0].title).toBe('list 2');

      // Over an hour old: not served, the screen waits for a new one.
      (svc as any).seriesCache.at -= 2 * 60 * 60 * 1000;
      expect((await svc.allSeriesNow())[0].title).toBe('list 3');

      // A list still on its way from a Sonarr that has since been changed in Settings is not kept.
      (svc as any).seriesCache.at -= 10 * 60 * 1000;
      void svc.allSeriesNow();
      svc.sonarrChanged();
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
      expect((svc as any).seriesCache).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});
