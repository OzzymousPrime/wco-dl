import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { APP_CONFIG } from './app-config.provider';
import { AppConfig } from './config';
import { JsonFileStore } from './json-file-store';
import { startProcess } from './process-runner';
import {
  dubVerdict,
  fileMatches,
  matchSeries,
  parsePremium,
  parseProgress,
  parseShowLink, CatalogueItem, CatalogueMatch, indexCatalogue, matchCatalogue, audioStatus, catalogueKey, normaliseTitle,
  playVerdict, Probe,
} from './fill.util';
import { diskState, DiskState, lowDiskMessage } from './disk-space';
import { WcoEpisodesService } from './wco-episodes.service';
import { WcoVerdict } from './wco-health';

const WCO_HELD = 'Until it reads again, no episode counts as missing from wcostream and none goes to Sonarr for that reason.';
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
import { fileIsEpisode, fileTitle, latestText, linkTitle, numberingFit, NumberingFit, resolveSources, Source } from './wco-episodes.util';

/**
 * The episode map's back end (11 Nov 2026): look a show up in Sonarr from its wco link, then fill the
 * episodes the user ticks, one at a time, with the rules the gap filler learned on its first nights:
 * - download into a per-episode staging folder; import only files from it, only into the episode asked for,
 *   and only when the file's name says it is that episode (never a part two such as "1145.5");
 * - ask Sonarr about the staging folder WITHOUT a seriesId: with one, Sonarr ignores the folder and lists the
 *   show's whole library (One Piece, 11 Nov 2026);
 * - a dub swap replaces a file only when ffprobe finds an English track (or untagged audio in a file named Dubbed);
 * - premium-only episodes are monitored and searched in Sonarr instead.
 */

const execFileAsync = promisify(execFile);
const WCO_SHOW = 'https://www.wcostream.tv/anime/';
const VIDEO = /\.(mp4|mkv|avi|m4v)$/i;
const MAX_JOBS = 50;

/** 'unknown': a file whose audio language is not labelled. Never swapped automatically; a person may pick it. */
export type EpisodeStatus = 'dub' | 'undub' | 'unknown' | 'missing' | 'future';
export type FillState =
  | 'queued' | 'downloading' | 'importing' | 'done' | 'premium' | 'kept' | 'failed' | 'cancelled';

export interface MapEpisode {
  id: number; s: number; e: number; abs?: number; t: string; a: string;
  st: EpisodeStatus; au: string; f: string; q: string;
}

export interface FillEpisode {
  id: number; s: number; e: number; abs?: number; title: string;
  mode: 'missing' | 'swap'; state: FillState; progress?: number; message?: string;
  /** When wcostream said its servers were busy: not before this time, and how many busy answers so far. */
  notBefore?: string; busy?: number;
  /** Hidden from the "Needs you" list by hand. */
  dismissed?: boolean;
  /** A failed episode gets one more go by itself when the queue runs dry; this marks that it has had it. */
  autoRetried?: boolean;
  /** Set when the second attempt asks for another quality than the run's. */
  quality?: string;
}

export interface FillJob {
  id: string; seriesId: number; title: string; slug: string; language?: 'dub' | 'sub';
  quality: string; absolute: boolean; createdAt: string; finishedAt?: string; episodes: FillEpisode[];
  /** Queued by the nightly plan for a followed show: runs only in the night window. */
  auto?: boolean;
  /** Episodes in a row that wcostream's video server refused (see VIDEO_REFUSED). */
  refused?: number;
}

interface ShowPref {
  seriesId: number; absolute?: boolean;
  /** Followed: the nightly plan fills its gaps (and swaps to the dub when language is dub). */
  follow?: boolean; language?: 'dub' | 'sub'; title?: string; lastPlanned?: string;
  /** Per episode: how many nightly attempts so far and when the last one was. */
  tries?: { [episodeId: string]: { n: number; last: string; handedToSonarr?: boolean } };
  /** From the last count (the nightly plan, a look-up, or "Recount"): aired episodes with no file, monitored or not, and Japanese-only files. */
  counts?: { missing: number; undub: number; at: string };
  /** Episodes the last night's plan found wcostream does not list (so were not queued). */
  unlisted?: { ids: number[]; at: string };
  /** From the last numbering check: how many episodes that need work the site lists under each way of numbering. */
  numbering?: NumberingFit & { at: string };
  /** Episodes already announced as new on wcostream in English (the new-dub check), so each is told once. */
  announced?: number[];
}
interface ShowPrefs { [slug: string]: ShowPref }

/** Retry an episode this many days after it aired (or after the last try); after the last, hand it to Sonarr. */
export const RETRY_DAYS = [1, 3, 7, 14];
/** Automatic runs only start in this local-time window (set the container's TZ, e.g. TZ=Europe/London). */
export const NIGHT = { from: 1, to: 7 };
/** At most this many episodes are planned per night, across all followed shows; the shows with the fewest due go first, so shows finish one by one. */
export const NIGHT_BUDGET = 120;
/** What the settings screen can change (12 Nov 2026); kept in <config>/settings.json. NIGHT holds the window. */
export const SETTINGS = { nightBudget: NIGHT_BUDGET, quality: '1080' as '1080' | '480' };
/** A window that ends before it starts runs past midnight (23 to 6). */
export function isNight(d = new Date()): boolean {
  const h = d.getHours();
  return NIGHT.from < NIGHT.to ? h >= NIGHT.from && h < NIGHT.to : h >= NIGHT.from || h < NIGHT.to;
}
/** The settings a request may set, checked. Unknown or bad values are ignored, so the file can never hold nonsense. */
export function cleanSettings(body: any): Partial<{ nightFrom: number; nightTo: number; nightBudget: number; quality: '1080' | '480' }> {
  const out: any = {};
  const hour = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 23 && v !== '' && v !== null ? Number(v) : undefined);
  const from = hour(body?.nightFrom), to = hour(body?.nightTo);
  if (from !== undefined && to !== undefined && from !== to) { out.nightFrom = from; out.nightTo = to; }
  const n = Number(body?.nightBudget);
  if (Number.isInteger(n) && n >= 1 && n <= 1000) out.nightBudget = n;
  if (body?.quality === '1080' || body?.quality === '480') out.quality = body.quality;
  return out;
}

/** Is a nightly attempt due for an episode that aired on airDate, given its earlier tries? */
export function retryDue(airDate: string, tries: { n: number; last: string } | undefined, now = new Date()): 'due' | 'wait' | 'give-up' {
  const n = tries?.n ?? 0;
  if (n >= RETRY_DAYS.length) return 'give-up';
  const since = new Date(tries?.last ?? (airDate ? airDate + 'T12:00:00Z' : 0));
  const days = (now.getTime() - since.getTime()) / 86400000;
  return days >= RETRY_DAYS[n] ? 'due' : 'wait';
}

/** What the followed list takes from Sonarr, as last seen: per series id, [episodes, episodes with a file] and second folders. */
interface FollowedFacts { at: number; ids: number[]; stats: Record<number, [number, number]>; split: Record<number, string[]> }
/** Sonarr's series list is used without asking again for this long. */
const SERIES_FRESH_MS = 5 * 60 * 1000;
/** Screens may be shown a list up to this old while a new one is fetched; older than this they wait. */
const SERIES_STALE_OK_MS = 60 * 60 * 1000;
const FACTS_FRESH_MS = 5 * 60 * 1000;
const FACTS_RETRY_MS = 60 * 1000;
/** The new-dub check looks at episodes aired this many days back. */
const NEW_DUB_DAYS = 21;
/** Below the free-space limit the queue looks again this often, and says so at most this often. */
const DISK_RECHECK_MS = 10 * 60 * 1000;
const DISK_TELL_MS = 12 * 3600 * 1000;
/** An episode wcostream has not listed at two checks running goes to Sonarr at once if it aired this long ago (18 Nov 2026). */
export const UNLISTED_HAND_DAYS = 14;
/** Needs you offers to delete staged downloads untouched for this long. */
export const STAGE_OLD_DAYS = 14;
/** "wcostream cannot be read" is sent at most this often. */
const WCO_TELL_MS = 12 * 3600 * 1000;

/** Files and bytes under a folder, and when anything in it last changed. */
async function dirStats(dir: string): Promise<{ files: number; bytes: number; newest: number }> {
  const out = { files: 0, bytes: 0, newest: 0 };
  for (const f of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) {
      const d = await dirStats(p);
      out.files += d.files; out.bytes += d.bytes; out.newest = Math.max(out.newest, d.newest);
      continue;
    }
    const st = await fs.stat(p).catch(() => undefined);
    if (!st) continue;
    out.newest = Math.max(out.newest, st.mtimeMs);
    if (f.name !== 'downloader.log') { out.files++; out.bytes += st.size; }
  }
  return out;
}

@Injectable()
export class FillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FillService.name);
  private jobs: FillJob[] = [];
  private running = false;
  private current?: { kill: () => void; jobId: string; episodeId: number };
  private seriesCache?: { at: number; list: any[] };

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig, @Optional() private readonly wco?: WcoEpisodesService) {}

  private get configDir() { return this.config.configDir; }
  private get jobsFile() { return path.join(this.configDir, 'fill-jobs.json'); }
  private get prefsFile() { return path.join(this.configDir, 'show-prefs.json'); }
  private get stateFile() { return path.join(this.configDir, 'queue-state.json'); }
  private get settingsFile() { return path.join(this.configDir, 'settings.json'); }

  // ---------- Settings ----------
  private applySettings(s: ReturnType<typeof cleanSettings>) {
    if (s.nightFrom !== undefined && s.nightTo !== undefined) { NIGHT.from = s.nightFrom; NIGHT.to = s.nightTo; }
    if (s.nightBudget !== undefined) SETTINGS.nightBudget = s.nightBudget;
    if (s.quality) SETTINGS.quality = s.quality;
  }
  getSettings() { return { nightFrom: NIGHT.from, nightTo: NIGHT.to, nightBudget: SETTINGS.nightBudget, quality: SETTINGS.quality }; }
  async setSettings(body: unknown) {
    this.applySettings(cleanSettings(body));
    await fs.mkdir(this.configDir, { recursive: true });
    const tmp = this.settingsFile + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.getSettings(), null, 2));
    await fs.rename(tmp, this.settingsFile);
    void this.pump();     // a wider window may let a waiting run start now
    return this.getSettings();
  }
  private paused = false;

  async onApplicationBootstrap() {
    // Sonarr's series list is slow on a big library: fetch it now, so the first screen that needs it does not wait.
    if (this.config.sonarrApiKey) setTimeout(() => this.fetchSeries().catch(() => undefined), 0);
    try {
      this.jobs = JSON.parse(await fs.readFile(this.jobsFile, 'utf8'));
      // A restart cut these off: queue them again. The downloader resumes a partial file (11 Nov 2026).
      for (const j of this.jobs) for (const e of j.episodes) {
        if (e.state === 'downloading' || e.state === 'importing') { e.state = 'queued'; e.message = 'Resumed after a restart'; }
      }
      // The same episode queued in two runs would download twice: keep the oldest, cancel the rest.
      const seen = new Set<number>();
      for (const j of this.jobs) for (const e of j.episodes) {
        if (e.state !== 'queued') continue;
        if (seen.has(e.id)) { e.state = 'cancelled'; e.message = 'Already queued in an earlier run'; } else seen.add(e.id);
      }
      // Parked overnight episodes whose wait has passed: they start on the next night, so say that.
      const nowIso = new Date().toISOString();
      for (const j of this.jobs) if (j.auto) for (const e of j.episodes) {
        if (e.state === 'queued' && e.notBefore && e.notBefore < nowIso && /the rest wait until \d/.test(e.message ?? '')) {
          e.message = e.message!.replace(/the rest wait until .*$/, 'the rest wait for the next overnight run');
        }
      }
    } catch { this.jobs = []; }
    try { this.paused = !!JSON.parse(await fs.readFile(this.stateFile, 'utf8')).paused; } catch { this.paused = false; }
    try { this.applySettings(cleanSettings(JSON.parse(await fs.readFile(this.settingsFile, 'utf8')))); } catch { /* defaults */ }
    const health = this.wco?.health;
    if (health) health.onChange = (v) => void this.tellWco(v).catch((e) => this.logger.warn(`wcostream message failed: ${(e as Error).message}`));
    void this.pump();
  }

  // ---------- Queue controls ----------
  async queueState() {
    const disk = await this.checkDisk();
    return { paused: this.paused, night: isNight(), nightBudget: SETTINGS.nightBudget, disk, wco: this.wcoVerdict() };
  }

  // ---------- wcostream unreadable (18 Nov 2026) ----------
  // Byparr down, a challenge it cannot pass, or a new page layout all look the same from here: pages that fail or
  // come back empty. Until one reads properly, no episode counts as "not listed", none is handed to Sonarr for it,
  // and a message says so: during the day at once, after a night in the morning summary (or at 10:00).
  private wcoToldAt = 0;
  private wcoTold = false;
  private wcoPending = false;
  private wcoVerdict(): WcoVerdict { return this.wco?.health?.verdict() ?? { ok: true }; }
  private async tellWco(v: WcoVerdict) {
    const url = this.config.publicUrl ? `${this.config.publicUrl}/map.html` : undefined;
    if (v.ok) {
      this.wcoPending = false;
      this.logger.log('wcostream reads again');
      if (!this.wcoTold) return;
      this.wcoTold = false;
      if (isNight()) { this.nightNotes.push('wcostream reads again.'); return; }
      await this.push('wco-dl: wcostream reads again', 'Pages from wcostream have episodes on them again; nothing else to do.', url);
      return;
    }
    this.logger.warn(`wcostream cannot be read: ${v.why}`);
    if (isNight()) { this.wcoPending = true; return; }
    if (Date.now() - this.wcoToldAt < WCO_TELL_MS) return;
    this.wcoToldAt = Date.now(); this.wcoTold = true; this.wcoPending = false;
    await this.push('wco-dl: wcostream cannot be read', `${v.why![0].toUpperCase() + v.why!.slice(1)}.\n${WCO_HELD}`, url);
  }

  // ---------- Free space (17 Nov 2026) ----------
  private disk?: DiskState;
  private diskTimer?: NodeJS.Timeout;
  private diskToldAt = 0;
  private async checkDisk(): Promise<DiskState> {
    this.disk = await diskState(this.config.outputBase, this.config.minFreeGb ?? 0);
    return this.disk;
  }
  /** Below the limit: nothing starts. Look again in ten minutes, and send a message, at most twice a day. */
  private async stopForSpace(disk: DiskState) {
    if (!this.diskTimer) {
      this.diskTimer = setTimeout(() => { this.diskTimer = undefined; void this.pump(); }, DISK_RECHECK_MS);
      this.diskTimer.unref?.();
    }
    if (Date.now() - this.diskToldAt < DISK_TELL_MS) return;
    this.diskToldAt = Date.now();
    this.logger.warn(lowDiskMessage(disk));
    await this.push('wco-dl stopped: disk nearly full',
      `${lowDiskMessage(disk)}.\nFree some space and the queue starts again by itself within ten minutes.`,
      this.config.publicUrl ? `${this.config.publicUrl}/map.html#queue` : undefined)
      .catch((e) => this.logger.warn(`Disk message failed: ${(e as Error).message}`));
  }

  /** Paused: the episode in hand finishes, nothing new starts (manual or overnight) until resumed. Survives a restart. */
  async setPaused(paused: boolean) {
    this.paused = !!paused;
    await fs.mkdir(this.configDir, { recursive: true });
    await fs.writeFile(this.stateFile, JSON.stringify({ paused: this.paused }));
    if (!this.paused) void this.pump();
    return this.queueState();
  }

  /** Put a waiting run at the head of the queue. An overnight run becomes an ordinary one, so it starts now. */
  async runNext(id: string) {
    const job = this.getJob(id);
    if (!job.episodes.some((e) => e.state === 'queued')) throw new BadRequestException('Nothing in that run is waiting');
    this.jobs.splice(this.jobs.indexOf(job), 1);
    this.jobs.unshift(job);
    job.auto = false;
    await this.save();
    void this.pump();
    return job;
  }

  /** Queue one failed or kept episode of a run again. */
  async retryEpisode(jobId: string, episodeId: number) {
    const job = this.getJob(jobId);
    const ep = job.episodes.find((e) => e.id === episodeId);
    if (!ep) throw new NotFoundException('No such episode in this run');
    if (this.activeIds().has(ep.id)) throw new ConflictException('That episode is already in the queue');
    ep.state = 'queued'; ep.message = undefined; ep.dismissed = undefined; ep.busy = undefined; ep.notBefore = undefined;
    job.finishedAt = undefined;
    await this.save();
    void this.pump();
    return job;
  }

  /**
   * What needs a person: for each episode, its newest run ended failed, downloaded-but-not-imported, or premium-only
   * (handed to Sonarr). Episodes that have a file by now are left out, and so are the ones dismissed by hand.
   */
  async attention() {
    const latest = new Map<number, { job: FillJob; ep: FillEpisode }>();
    for (const job of this.jobs) for (const ep of job.episodes) if (ep.state !== 'cancelled') latest.set(ep.id, { job, ep });
    let items = [...latest.values()].filter(({ ep }) => (ep.state === 'failed' || ep.state === 'kept' || ep.state === 'premium') && !ep.dismissed);
    const filled = new Set<number>();
    for (const seriesId of new Set(items.map((x) => x.job.seriesId))) {
      try {
        for (const e of await this.mapEpisodes(seriesId)) if (e.st === 'dub' || ((e.st === 'undub' || e.st === 'unknown') && latest.get(e.id)?.ep.mode === 'missing')) filled.add(e.id);
      } catch { /* Sonarr did not answer: keep the rows */ }
    }
    items = items.filter(({ ep }) => !filled.has(ep.id));
    return items
      .map(({ job, ep }) => ({ jobId: job.id, seriesId: job.seriesId, show: job.title, slug: job.slug, auto: !!job.auto, at: job.finishedAt ?? job.createdAt,
        id: ep.id, s: ep.s, e: ep.e, title: ep.title, mode: ep.mode, state: ep.state, message: ep.message ?? '' }))
      .sort((a, b) => b.at.localeCompare(a.at) || a.show.localeCompare(b.show) || a.s - b.s || a.e - b.e);
  }

  async dismiss(jobId: string, episodeId: number) {
    const ep = this.getJob(jobId).episodes.find((e) => e.id === episodeId);
    if (!ep) throw new NotFoundException('No such episode in this run');
    ep.dismissed = true;
    await this.save();
    return { ok: true };
  }

  /** Count missing and other-language-only episodes for every linked show (two Sonarr calls each) and remember them. */
  async recount() {
    const counted = new Map<string, { missing: number; undub: number; at: string }>();
    for (const [slug, pref] of Object.entries(await this.prefs())) {   // every linked show: the unfollowed ones hide gaps too
      try { counted.set(slug, countMap(await this.mapEpisodes(pref.seriesId))); }
      catch (err) { this.logger.warn(`Recount ${slug}: ${(err as Error).message}`); }
    }
    await this.changePrefs((prefs) => { for (const [slug, c] of counted) if (prefs[slug]) prefs[slug].counts = c; });
    return { counted: counted.size };
  }

  // ---------- Sonarr ----------
  // async on purpose: a missing key must come back as a rejected promise, never a throw. A throw while building
  // Promise.all([...]) left the first call's rejection unhandled, and Node stopped the server (14 Nov 2026).
  private async sonarr<T = any>(method: 'get' | 'post' | 'put', url: string, data?: unknown): Promise<T> {
    const { sonarrUrl, sonarrApiKey } = this.config;
    if (!sonarrApiKey) throw new BadRequestException('This screen needs Sonarr. Connect it in Settings.');
    return axios.request<T>({ method, url: `${sonarrUrl}/api/v3/${url}`, data, timeout: 120000,
      headers: { 'X-Api-Key': sonarrApiKey } }).then((r) => r.data);
  }

  /** Sonarr series id to its linked wcostream show, for screens that offer "Open map". */
  async linkedSlugs(): Promise<Map<number, string>> {
    return new Map(Object.entries(await this.prefs()).map(([slug, p]) => [p.seriesId, slug]));
  }

  async allSeries(): Promise<any[]> {
    if (this.seriesCache && Date.now() - this.seriesCache.at < SERIES_FRESH_MS) return this.seriesCache.list;
    return this.fetchSeries();
  }

  /**
   * For screens that should not wait on Sonarr (its whole list takes seconds on a big library): the last list at
   * once, even if it is older than five minutes, refreshed behind. Waits when there is none, or it is over an hour old.
   */
  async allSeriesNow(): Promise<any[]> {
    if (!this.seriesCache || Date.now() - this.seriesCache.at >= SERIES_STALE_OK_MS) return this.fetchSeries();
    if (Date.now() - this.seriesCache.at >= SERIES_FRESH_MS) this.fetchSeries().catch(() => undefined);
    return this.seriesCache.list;
  }

  /** True while Sonarr's series list is being fetched. */
  get seriesRefreshing(): boolean { return !!this.seriesFetch; }

  private seriesFetch?: Promise<any[]>;
  private seriesGen = 0;
  /** One fetch at a time; a list fetched from a Sonarr that has since been changed in Settings is thrown away. */
  private fetchSeries(): Promise<any[]> {
    const gen = this.seriesGen;
    return (this.seriesFetch ??= this.sonarr<any[]>('get', 'series')
      .then((list) => { if (gen === this.seriesGen) this.seriesCache = { at: Date.now(), list }; return list; })
      .finally(() => { this.seriesFetch = undefined; }));
  }

  /**
   * A show's poster for the lists: Sonarr's own small copy (250 px wide, about 25 KB). The server fetches it, so the
   * browser never holds the Sonarr key. No Sonarr, no poster yet, or anything that is not a picture: 404, and the
   * screen draws the show's initials instead.
   */
  async poster(seriesId: number): Promise<{ data: Buffer; type: string }> {
    const { sonarrUrl, sonarrApiKey } = this.config;
    if (!sonarrApiKey || !Number.isInteger(seriesId) || seriesId <= 0) throw new NotFoundException('No poster');
    try {
      const r = await axios.request<ArrayBuffer>({ method: 'get', url: `${sonarrUrl}/api/v3/mediacover/${seriesId}/poster-250.jpg`,
        responseType: 'arraybuffer', timeout: 20000, headers: { 'X-Api-Key': sonarrApiKey } });
      const type = String(r.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!type.startsWith('image/')) throw new Error('not a picture');
      return { data: Buffer.from(r.data), type };
    } catch {
      throw new NotFoundException('No poster');
    }
  }

  /** The Windows path Sonarr sees for a folder under OUTPUT_BASE (see SONARR_IMPORT_BASE). */
  private sonarrPath(folder: string): string {
    const { outputBase, sonarrImportBase } = this.config;
    if (!sonarrImportBase || !folder.startsWith(outputBase)) return folder;
    const sep = sonarrImportBase.includes('\\') ? '\\' : '/';
    const rest = folder.slice(outputBase.length).split(/[\\/]/).filter(Boolean);
    return [sonarrImportBase.replace(/[\\/]+$/, ''), ...rest].join(sep);
  }

  private splitCache?: { at: number; map: Map<number, string[]> };
  /**
   * Folders Sonarr does not track whose name is a tracked series' name (years aside): the same show in a second
   * folder, often on another drive. Episodes there read as missing (11 Nov 2026: 56 such folders). A folder whose
   * year differs from the series' year, or whose name fits two series, is not counted.
   */
  async splitFolders(): Promise<Map<number, string[]>> {
    if (this.splitCache && Date.now() - this.splitCache.at < 10 * 60 * 1000) return this.splitCache.map;
    const map = new Map<number, string[]>();
    try {
      const [all, roots] = await Promise.all([this.allSeriesNow(), this.sonarr<any[]>('get', 'rootfolder')]);
      const base = (p: string) => String(p ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
      const byKey = new Map<string, Set<number>>();
      for (const s of all) for (const k of new Set([normaliseTitle(s.title), normaliseTitle(base(s.path))])) {
        if (k) byKey.set(k, (byKey.get(k) ?? new Set()).add(s.id));
      }
      const tracked = new Set(all.map((s) => String(s.path).replace(/[\\/]+$/, '').toLowerCase()));
      for (const r of roots) for (const u of r.unmappedFolders ?? []) {
        const p = String(u.path).replace(/[\\/]+$/, '');
        const ids = byKey.get(normaliseTitle(u.name));
        if (!ids || ids.size !== 1 || tracked.has(p.toLowerCase())) continue;
        const s = all.find((x) => x.id === [...ids][0]);
        const year = /\((19\d\d|20\d\d)\)/.exec(u.name)?.[1];
        if (year && s.year && Number(year) !== s.year) continue;
        map.set(s.id, [...(map.get(s.id) ?? []), p]);
      }
    } catch (err) { this.logger.warn(`Split folders: ${(err as Error).message}`); }
    this.splitCache = { at: Date.now(), map };
    return map;
  }

  // ---------- Adding a show to Sonarr from a wcostream search result ----------
  /** New shows go where the most recently added animated series went, with its profile and settings. */
  async addDefaults() {
    const all = await this.allSeries();
    const last = all.filter((s) => (s.genres ?? []).some((g: string) => g === 'Animation' || g === 'Anime') && s.added)
      .sort((a, b) => String(b.added).localeCompare(String(a.added)))[0];
    if (!last) throw new BadRequestException('Sonarr has no animated series to copy settings from');
    const profiles = await this.sonarr<any[]>('get', 'qualityprofile').catch(() => []);
    return {
      rootFolderPath: (last.rootFolderPath ?? String(last.path).replace(/[\\/][^\\/]+[\\/]?$/, '')) as string,
      qualityProfileId: last.qualityProfileId as number,
      qualityProfile: (profiles.find((p) => p.id === last.qualityProfileId)?.name ?? `profile ${last.qualityProfileId}`) as string,
      seasonFolder: !!last.seasonFolder, seriesType: (last.seriesType ?? 'standard') as string, copiedFrom: last.title as string,
    };
  }

  /**
   * Add the show a wcostream result names. With `tvdbId` that exact series; else the one Sonarr finds with the same
   * name. Several of the same name (or none): nothing is added and the choices come back for a pick.
   * Episodes are monitored but Sonarr is not told to search: wco-dl fills them.
   */
  async addToSonarr(body: { name?: string; slug?: string; tvdbId?: number }) {
    const name = String(body?.name ?? '').replace(/\b(English )?(Dubbed|Subbed)\b/gi, '').trim();
    if (name.length < 2) throw new BadRequestException('Which show?');
    const found = await this.sonarr<any[]>('get', `series/lookup?term=${encodeURIComponent(body.tvdbId ? `tvdb:${Number(body.tvdbId)}` : name)}`);
    const brief = (s: any) => ({ tvdbId: s.tvdbId, title: s.title, year: s.year, network: s.network ?? '', inSonarr: !!s.id });
    const want = catalogueKey(name);
    const pick = body.tvdbId ? found.filter((s) => s.tvdbId === Number(body.tvdbId))
      : found.filter((s) => [s.title, ...(s.alternateTitles ?? []).map((t: any) => t.title)].map(normaliseTitle).includes(want));
    if (pick.length !== 1) return { added: false, choices: (pick.length ? pick : found).slice(0, 8).map(brief) };
    const s = pick[0];
    if (s.id) return { added: false, already: true, series: { id: s.id, title: s.title, path: s.path } };
    const d = await this.addDefaults();
    const made = await this.sonarr<any>('post', 'series', {
      ...s, rootFolderPath: d.rootFolderPath, qualityProfileId: d.qualityProfileId, seasonFolder: d.seasonFolder,
      seriesType: d.seriesType, monitored: true,
      addOptions: { monitor: 'all', searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false },
    });
    this.seriesCache = undefined;
    this.logger.log(`Added to Sonarr: ${made.title} at ${made.path}`);
    if (body.slug) await this.setLinks({ items: [{ slug: body.slug, seriesId: made.id }] }).catch(() => undefined);
    return { added: true, series: { id: made.id, title: made.title, path: made.path } };
  }

  // The show links and follows. Every change goes through changePrefs: it is applied to a fresh read, one change at
  // a time, and the file is replaced in one step. Before (15 Nov 2026) a long job such as the nightly plan wrote back
  // the copy it had read when it started, wiping a follow made meanwhile, and a file cut short by a restart read as
  // "no shows" and was then saved that way. Keep slow work (Sonarr, wcostream) outside the change.
  private prefsStore?: JsonFileStore<ShowPrefs>;
  private get store() {
    return (this.prefsStore ??= new JsonFileStore<ShowPrefs>(this.prefsFile, () => ({}), (m) => this.logger.warn(m)));
  }

  private async prefs(): Promise<ShowPrefs> {
    try { return await this.store.read(); } catch (e) { throw new ServiceUnavailableException((e as Error).message); }
  }

  private async changePrefs(change: (p: ShowPrefs) => void): Promise<ShowPrefs> {
    try { return await this.store.update(change); } catch (e) { throw new ServiceUnavailableException((e as Error).message); }
  }

  // ---------- Look-up ----------
  async lookup(link: string, seriesIdParam?: string, absoluteParam?: string) {
    let parsed;
    try { parsed = parseShowLink(link); } catch (e) { throw new BadRequestException((e as Error).message); }
    const prefs = await this.prefs();
    let all = await this.allSeriesNow();
    let seriesId = seriesIdParam ? Number(seriesIdParam) : prefs[parsed.slug]?.seriesId;
    // Added in Sonarr since the list was fetched: ask again rather than say it is not there.
    if (seriesId && !all.some((s) => s.id === seriesId)) all = await this.fetchSeries();
    const candidates = matchSeries(parsed.slug, all);
    if (!seriesId && candidates.length === 1) seriesId = candidates[0].id;
    const brief = (s: any) => ({ id: s.id, title: s.title, year: s.year, path: s.path });
    if (!seriesId) {
      return { slug: parsed.slug, language: parsed.language, series: null, candidates: candidates.map(brief), episodes: [] };
    }
    const series = all.find((s) => s.id === seriesId) ?? (await this.sonarr('get', `series/${seriesId}`));
    let absolute = prefs[parsed.slug]?.absolute ?? false;
    if (absoluteParam !== undefined) absolute = absoluteParam === 'true';
    const slug = parsed.slug;
    let pref = prefs[slug];
    if (seriesIdParam || absoluteParam !== undefined || !pref) {
      const link = { seriesId, absolute, title: series.title as string };
      pref = (await this.changePrefs((p) => { p[slug] = { ...p[slug], ...link }; }))[slug];
    }
    const episodes = await this.mapEpisodes(seriesId);
    if (pref?.follow) {                 // keep the home list's counts fresh for a show that was just looked at
      const counts = countMap(episodes);
      await this.changePrefs((p) => { if (p[slug]) p[slug].counts = counts; });
    }
    return {
      slug: parsed.slug, language: parsed.language, series: brief(series), absolute,
      follow: !!pref?.follow, followLanguage: pref?.language ?? 'dub',
      candidates: candidates.map(brief), episodes, split: (await this.splitFolders()).get(seriesId) ?? [],
    };
  }

  /** For wcostream search results: is each show in Sonarr (by its remembered link, else by one exact name match), and is it followed? */
  async inSonarr<T extends { slug: string }>(matches: T[]) {
    const [all, prefs] = await Promise.all([this.allSeriesNow(), this.prefs()]);
    return matches.map((m) => {
      const pref = prefs[m.slug];
      // Without a remembered link only an exact name counts: a near match ("Life" for "Life With an Ordinary Guy...") is a guess.
      const want = [catalogueKey(m.slug.replace(/-/g, ' ')), catalogueKey((m as { name?: string }).name ?? '')].filter(Boolean);
      const names = (x: any) => [x.title, x.titleSlug ?? '', ...(x.alternateTitles ?? []).map((t: any) => t.title)].map(normaliseTitle);
      const found = pref ? all.filter((x) => x.id === pref.seriesId) : all.filter((x) => names(x).some((k) => want.includes(k)));
      const series = found.length === 1 ? found[0] : undefined;
      return { ...m, series: series ? { id: series.id, title: series.title, path: series.path } : null, follow: !!pref?.follow };
    });
  }

  async searchSeries(q: string) {
    const want = String(q ?? '').toLowerCase().trim();
    if (want.length < 2) return [];
    return (await this.allSeriesNow())
      .filter((s) => s.title.toLowerCase().includes(want))
      .slice(0, 20)
      .map((s) => ({ id: s.id, title: s.title, year: s.year, path: s.path }));
  }

  private async mapEpisodes(seriesId: number): Promise<MapEpisode[]> {
    const [eps, files] = await Promise.all([
      this.sonarr<any[]>('get', `episode?seriesId=${seriesId}`),
      this.sonarr<any[]>('get', `episodefile?seriesId=${seriesId}`),
    ]);
    const byId = new Map(files.map((f) => [f.id, f]));
    const now = new Date().toISOString();
    return eps
      .filter((e) => e.seasonNumber > 0)
      .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber)
      .map((e) => {
        const f = byId.get(e.episodeFileId);
        const audio = f?.mediaInfo?.audioLanguages ?? '';
        const aired = !!e.airDateUtc && e.airDateUtc < now;
        const st: EpisodeStatus = f ? audioStatus(audio) : aired ? 'missing' : 'future';
        return {
          id: e.id, s: e.seasonNumber, e: e.episodeNumber, abs: e.absoluteEpisodeNumber ?? undefined,
          t: e.title, a: e.airDate ?? '', st, au: audio,
          f: f ? String(f.relativePath).split(/[\\/]/).pop() : '', q: f?.quality?.quality?.name ?? '',
        };
      });
  }

  // ---------- Jobs ----------
  listJobs(): FillJob[] { return this.jobs.slice().reverse(); }

  getJob(id: string): FillJob {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) throw new NotFoundException('No such job');
    return j;
  }

  /** Episode ids queued or running in any run: a second run for them would download everything twice. */
  private activeIds(): Set<number> {
    return new Set(this.jobs.flatMap((j) => j.episodes.filter((e) => ['queued', 'downloading', 'importing'].includes(e.state)).map((e) => e.id)));
  }

  async createJob(body: { seriesId?: number; slug?: string; language?: string; quality?: string; absolute?: boolean; episodeIds?: number[]; auto?: boolean }) {
    const seriesId = Number(body?.seriesId);
    const ids = Array.isArray(body?.episodeIds) ? body.episodeIds.map(Number).filter(Number.isFinite) : [];
    if (!seriesId || !ids.length) throw new BadRequestException('Pick a show and at least one episode');
    if (ids.length > 200) throw new BadRequestException('At most 200 episodes per run');
    const slug = parseShowLink(String(body.slug ?? '')).slug;
    const language = body.language === 'dub' || body.language === 'sub' ? body.language : undefined;
    const quality = body.quality === '480' || body.quality === '1080' ? body.quality : SETTINGS.quality;
    const map = await this.mapEpisodes(seriesId);
    const series = await this.sonarr('get', `series/${seriesId}`);
    // An automatic run never touches a file whose audio is not labelled; a person may pick one on the map.
    const swappable = (st: EpisodeStatus) => st === 'undub' || (st === 'unknown' && !body.auto);
    const needed = map.filter((e) => ids.includes(e.id) && (e.st === 'missing' || (swappable(e.st) && language !== 'sub')));
    if (!needed.length) throw new BadRequestException('None of those episodes needs work');
    const busy = this.activeIds();
    const picked = needed.filter((e) => !busy.has(e.id));
    if (!picked.length) throw new ConflictException('Those episodes are already in the queue');
    const job: FillJob = {
      id: randomUUID(), seriesId, title: series.title, slug, language, quality, absolute: !!body.absolute, auto: !!body.auto,
      createdAt: new Date().toISOString(),
      episodes: picked.map((e) => ({ id: e.id, s: e.s, e: e.e, abs: e.abs, title: e.t,
        mode: e.st === 'missing' ? 'missing' : 'swap', state: 'queued' })),
    };
    this.jobs.push(job);
    if (this.jobs.length > MAX_JOBS) this.jobs.splice(0, this.jobs.length - MAX_JOBS);
    await this.save();
    void this.pump();
    return job;
  }

  async cancel(id: string) {
    const job = this.getJob(id);
    for (const e of job.episodes) if (e.state === 'queued') { e.state = 'cancelled'; }
    if (this.current?.jobId === id) {
      const running = job.episodes.find((e) => e.id === this.current!.episodeId);
      if (running) { running.state = 'cancelled'; running.message = 'Cancelled'; }
      this.current.kill();
    }
    await this.save();
    return job;
  }

  private saving?: Promise<void>;
  private async save() {
    const write = async () => {
      await fs.mkdir(this.configDir, { recursive: true });
      const tmp = this.jobsFile + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(this.jobs));
      await fs.rename(tmp, this.jobsFile);
    };
    this.saving = (this.saving ?? Promise.resolve()).then(write, write);
    return this.saving;
  }

  /**
   * The queue has run dry: give each episode that failed in the last day one more attempt (a hiccup at wcostream is
   * the usual cause). Once only per episode; a second failure stays on the "Needs you" list.
   */
  private requeueFailedOnce(): boolean {
    const since = Date.now() - 24 * 3600 * 1000;
    const busy = this.activeIds();
    let any = false;
    for (const job of this.jobs) {
      if (new Date(job.createdAt).getTime() < since || (job.auto && !isNight())) continue;
      for (const ep of job.episodes) {
        if (ep.state !== 'failed' || ep.autoRetried || ep.dismissed || busy.has(ep.id)) continue;
        // wcostream does not list this episode under this number: asking again changes nothing.
        if (NOT_LISTED.test(ep.message ?? '')) { ep.autoRetried = true; continue; }
        // The HD file and its backup were both refused: the second attempt asks for the standard-definition file,
        // which is a different file on the server (12 Nov 2026, David: "do retries look for different qualities").
        const sd = VIDEO_REFUSED.test(ep.message ?? '') && (ep.quality ?? job.quality) !== '480';
        if (sd) ep.quality = '480';
        ep.autoRetried = true; ep.state = 'queued';
        ep.message = sd ? 'Second attempt in standard definition: the HD file was refused' : 'Second attempt, after the rest of the queue';
        job.finishedAt = undefined;
        busy.add(ep.id); any = true;
      }
    }
    return any;
  }

  private wakeTimer?: NodeJS.Timeout;
  /** Start the queue again when the earliest "servers busy" wait is over. */
  private scheduleWake() {
    const next = this.jobs.flatMap((j) => j.episodes).filter((e) => e.state === 'queued' && e.notBefore).map((e) => e.notBefore!).sort()[0];
    if (!next || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => { this.wakeTimer = undefined; void this.pump(); }, Math.max(1000, new Date(next).getTime() - Date.now() + 1000));
    this.wakeTimer.unref?.();
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const now = new Date().toISOString();
        const ready = (e: FillEpisode) => e.state === 'queued' && (!e.notBefore || e.notBefore <= now);
        if (this.paused) break;
        const job = this.jobs.find((j) => (!j.auto || isNight()) && j.episodes.some(ready));
        if (!job) {
          if (this.requeueFailedOnce()) continue;
          this.scheduleWake(); break;
        }
        const ep = job.episodes.find(ready)!;
        const disk = await this.checkDisk();
        if (disk.low) { await this.stopForSpace(disk); break; }
        try {
          await this.fillOne(job, ep);
        } catch (err) {
          ep.state = 'failed'; ep.message = (err as Error).message;
          this.logger.error(`${job.title} ${ep.s}x${ep.e}: ${ep.message}`);
        }
        // A brake (12 Nov 2026: Hercules and Casper failed 30 episodes in a row on "HTTP 404 instead of a video").
        // When the video server refuses several episodes of a show running, the rest wait instead of failing one by one.
        if (ep.state === 'failed' && VIDEO_REFUSED.test(ep.message ?? '')) {
          job.refused = (job.refused ?? 0) + 1;
          if (job.refused >= REFUSED_LIMIT) {
            const wait = Math.min(360, 60 * 2 ** (job.refused - REFUSED_LIMIT));
            const until = new Date(Date.now() + wait * 60000);
            for (const e of job.episodes) if (e.state === 'queued') {
              e.notBefore = until.toISOString();
              e.message = brakeMessage(job.refused, until, !!job.auto);
            }
            this.logger.warn(`${job.title}: ${job.refused} refusals in a row, waiting ${wait} minutes`);
          }
        } else if (ep.state === 'done') job.refused = 0;
        if (!job.episodes.some((e) => e.state === 'queued')) {
          job.finishedAt = new Date().toISOString();
          if (job.auto && !this.jobs.some((j) => j.auto && j.episodes.some((e) => ['queued', 'downloading', 'importing'].includes(e.state)))) {
            await this.notifyNight().catch((e) => this.logger.warn(`Summary push failed: ${(e as Error).message}`));
          }
        }
        await this.save();
      }
    } finally {
      this.running = false;
    }
  }

  private async fillOne(job: FillJob, ep: FillEpisode) {
    const { pythonBin, pythonScript, outputBase, downloadIdleTimeoutMs } = this.config;
    // One staging folder per show and episode, so a retry or "Import from staging" finds an earlier download.
    const out = this.stageDir(job, ep);
    await fs.mkdir(out, { recursive: true });
    ep.message = undefined;
    // Another run may have filled this episode since it was queued (11 Nov 2026: four swaps were queued in a second
    // run and finished by the first): ask Sonarr before downloading it again.
    try {
      const cur = await this.sonarr<any>('get', `episode/${ep.id}`);
      const audio = cur?.episodeFile?.mediaInfo?.audioLanguages ?? '';
      if (cur?.hasFile && (ep.mode === 'missing' || /eng/i.test(audio))) {
        ep.state = 'done';
        ep.message = ep.mode === 'swap' ? 'Already in English in the library' : 'Already in the library';
        return;
      }
    } catch { /* Sonarr did not answer: carry on, the import step reports it */ }
    // Which link is this episode (13 Nov 2026)? Sonarr's history showed files filed under the wrong episode on shows
    // where the site packs two segments into one numbered episode. The title decides; the number is used only when
    // the titles agree or cannot be compared. If the site's list cannot be read, the number is used and the
    // downloaded file's own title is checked before it is imported.
    let source: Source = { kind: 'number' };
    let importIds = [ep.id];
    const read = this.wco ? await this.wco.listing(job.slug, job.language ?? 'dub') : undefined;
    const listing = read && this.wcoVerdict().ok ? read : undefined;
    if (listing) {
      try {
        const map = await this.mapEpisodes(job.seriesId);
        source = resolveSources(listing, map, !!job.absolute).get(ep.id) ?? source;
        if (source.kind === 'title') {
          // One file can hold several episodes. It is filed under this one and under the others that have no file;
          // an episode that already has a file keeps it.
          const free = new Set(map.filter((e) => e.st === 'missing' || e.st === 'future').map((e) => e.id));
          importIds = source.ids.filter((id) => id === ep.id || free.has(id));
        }
      } catch { /* Sonarr did not answer: the number is used, and the file's title is checked below */ }
    }
    if (source.kind === 'none') {
      ep.state = 'failed';
      ep.message = source.why === 'unlisted' ? 'Not downloaded: wcostream does not list this episode under this season and number'
        : "Not downloaded: wcostream's episode of this number is another episode, and none there has this title";
      return;
    }
    const byTitle = source.kind === 'title' ? source : undefined;
    const matches =(f: string) => fileMatches(path.basename(f), { season: ep.s, episode: ep.e, absolute: ep.abs }, job.absolute);
    // Always run the downloader, even when a file is already in staging: it resumes a partial file (a run cut off
    // by a restart, 11 Nov 2026) and skips a complete one after checking its size, so a half file is never imported.
    let text = '';
    let result: { outcome: string } = { outcome: 'completed' };
    {
    ep.state = 'downloading'; ep.progress = 0;
    await this.save();

    const args = [pythonScript, '-i', byTitle ? byTitle.url : WCO_SHOW + job.slug, '-q', ep.quality ?? job.quality];
    if (!byTitle) {
      if (job.language) args.push('--lang', job.language);
      if (job.absolute) {
        if (!ep.abs) throw new Error('Sonarr has no absolute number for this episode');
        args.push('-epr', String(ep.abs));
      } else {
        args.push('-se', String(ep.s), '-epr', String(ep.e));
      }
    }
    args.push('-o', out + '/', '-t', '2', '--verbose');
    const proc = await startProcess({
      command: pythonBin, args, cwd: path.dirname(pythonScript), idleTimeoutMs: downloadIdleTimeoutMs,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      onOutput: (chunk) => {
        text = (text + chunk).slice(-20000);
        const p = parseProgress(chunk);
        if (p !== undefined && p !== ep.progress) ep.progress = p;
      },
    });
    this.current = { kill: proc.kill, jobId: job.id, episodeId: ep.id };
    result = await proc.result;
    this.current = undefined;
    await fs.writeFile(path.join(out, 'downloader.log'), text).catch(() => undefined);
    if ((ep.state as FillState) === 'cancelled') return;
    }

    const files = (await listFiles(out)).filter((f) => VIDEO.test(f));
    if (!files.length) {
      const premium = parsePremium(text);
      if (premium.length) {
        await this.premiumToSonarr(ep);
        ep.state = 'premium'; ep.message = 'Premium only on wcostream: monitored and searched in Sonarr';
      } else if (/Servers Busy|full capacity|HTTP 50[23]/i.test(text) && (ep.busy ?? 0) < BUSY_WAIT_MIN.length) {
        // wcostream refuses when its servers are full (11 Nov 2026, Re:Zero 3x10): wait and try again.
        const wait = BUSY_WAIT_MIN[ep.busy ?? 0];
        ep.busy = (ep.busy ?? 0) + 1;
        ep.state = 'queued';
        ep.notBefore = new Date(Date.now() + wait * 60000).toISOString();
        ep.message = `wcostream's servers were busy; trying again in ${wait} minutes (attempt ${ep.busy + 1} of ${BUSY_WAIT_MIN.length + 1})`;
      } else {
        ep.state = 'failed';
        ep.message = result.outcome === 'timed_out' ? 'The download stalled (no output for a while)' : failureReason(text);
      }
      return;
    }

    // By title: the file named after the link (an older file of another episode may be in this folder too).
    const want = byTitle
      ? files.find((f) => fileTitle(path.basename(f)) === linkTitle(byTitle.url)) ?? (files.length === 1 ? files[0] : undefined)
      : files.find(matches);
    if (!want) {
      ep.state = 'kept';
      ep.message = `Downloaded ${path.basename(files[0])}, which is not ${ep.s}x${pad(ep.e)}; left in staging`;
      return;
    }
    if (!byTitle && !fileIsEpisode(path.basename(want), ep.title)) {
      ep.state = 'kept';
      ep.message = `Downloaded ${path.basename(want)}, which is a different episode from "${ep.title}": the site numbers this show differently. Left in staging, not imported`;
      return;
    }
    if (ep.mode === 'swap') {
      const verdict = dubVerdict(await audioTags(want), path.basename(want));
      if (!verdict.ok) {
        ep.state = 'kept'; ep.message = `Not a dub (${verdict.why}); your file is untouched`;
        return;
      }
    }

    // Does it play, and is it about as long as an episode (17 Nov 2026)? Only names and sizes were checked, so an
    // error page saved as a video, or a clip cut short, would have been imported as the episode.
    const list = ep.s > 0 ? await this.allSeriesNow().catch(() => undefined) : undefined;
    const runtime = Array.isArray(list) ? list.find((s) => s.id === job.seriesId)?.runtime : undefined;
    const play: { ok: boolean; why?: string } = playVerdict(await this.probe(want), runtime);
    if (!play.ok) {
      ep.state = 'kept'; ep.message = `${play.why}; left in staging, not imported`;
      return;
    }

    ep.state = 'importing'; ep.progress = 100;
    await this.save();
    const winFolder = this.sonarrPath(out);
    const items = await this.sonarr<any[]>('get', `manualimport?folder=${encodeURIComponent(winFolder)}&filterExistingFiles=false`);
    const base = path.basename(want).toLowerCase();
    const item = items.find((i) => String(i.path).split(/[\\/]/).pop()!.toLowerCase() === base
      && String(i.path).toLowerCase().startsWith(winFolder.toLowerCase()));
    if (!item) {
      ep.state = 'kept'; ep.message = 'Sonarr could not see the file in staging';
      return;
    }
    const cmd = await this.sonarr('post', 'command', {
      name: 'ManualImport', importMode: 'move',
      files: [{ path: item.path, folderName: item.folderName, seriesId: job.seriesId, episodeIds: importIds,
        quality: item.quality, languages: item.languages ?? [], releaseGroup: item.releaseGroup,
        indexerFlags: 0, releaseType: importIds.length > 1 ? 'multiEpisode' : 'singleEpisode' }],
    });
    for (let i = 0; i < 120; i++) {
      await sleep(2000);
      const st = await this.sonarr('get', `command/${cmd.id}`);
      if (st.status === 'completed' || st.status === 'failed') break;
    }
    const after = await this.sonarr('get', `episode/${ep.id}`);
    if (after.hasFile) {
      ep.state = 'done';
      ep.message = (ep.mode === 'swap' ? 'Swapped to the dub' : 'In Sonarr') +
        (importIds.length > 1 ? `: one file for ${importIds.length} episodes, as the site has them together` : byTitle ? ', found by its title' : '');
      await fs.rm(out, { recursive: true, force: true }).catch(() => undefined);
    } else {
      ep.state = 'kept'; ep.message = 'Sonarr did not import it; the file is still in staging';
    }
  }

  /** ffprobe's view of a downloaded file (a method, so tests with a fake downloader can stand in for it). */
  private probe(file: string) { return probeFile(file); }

  private premiumToSonarr(ep: FillEpisode) { return this.handToSonarr([ep.id]); }
  /** Monitor the episodes in Sonarr and ask it to search for them: one call each, however many. */
  private async handToSonarr(ids: number[]) {
    await this.sonarr('put', 'episode/monitor', { episodeIds: ids, monitored: true });
    await this.sonarr('post', 'command', { name: 'EpisodeSearch', episodeIds: ids });
  }

  // ---------- Following and the nightly plan ----------
  async setFollow(body: { slug?: string; seriesId?: number; follow?: boolean; language?: string; absolute?: boolean }) {
    let slug: string;
    try { slug = parseShowLink(String(body?.slug ?? '')).slug; } catch (e) { throw new BadRequestException((e as Error).message); }
    const seriesId = Number(body?.seriesId);
    if (!seriesId) throw new BadRequestException('Look the show up first');
    const series = await this.sonarr('get', `series/${seriesId}`);
    const prefs = await this.changePrefs((p) => {
      p[slug] = { ...p[slug], seriesId, title: series.title, follow: !!body.follow,
        language: body.language === 'sub' ? 'sub' : 'dub', absolute: body.absolute ?? p[slug]?.absolute ?? false };
    });
    return { slug, ...prefs[slug] };
  }

  /** Link many wco shows to Sonarr series in one go, and optionally follow them. Never unfollows: without `follow` the existing choice stays. */
  async setLinks(body: { items?: { slug?: string; seriesId?: number; follow?: boolean; language?: string }[] }) {
    const items = Array.isArray(body?.items) ? body.items.slice(0, 2000) : [];
    if (!items.length) throw new BadRequestException('Nothing to link');
    const all = await this.allSeries();
    const linked: string[] = [];
    const skipped: { slug: string; why: string }[] = [];
    await this.changePrefs((prefs) => {
      for (const it of items) {
        let slug: string;
        try { slug = parseShowLink(String(it?.slug ?? '')).slug; } catch { skipped.push({ slug: String(it?.slug ?? ''), why: 'not a show link' }); continue; }
        const series = all.find((s) => s.id === Number(it.seriesId));
        if (!series) { skipped.push({ slug, why: 'that series is not in Sonarr' }); continue; }
        const had = prefs[slug];
        if (had && had.seriesId !== series.id) { skipped.push({ slug, why: 'already linked to another series' }); continue; }
        prefs[slug] = { ...had, seriesId: series.id, title: series.title, absolute: had?.absolute ?? false,
          follow: it.follow === undefined ? !!had?.follow : !!it.follow,
          language: it.language === 'sub' ? 'sub' : it.language === 'dub' ? 'dub' : had?.language ?? 'dub' };
        linked.push(slug);
      }
    });
    return { linked: linked.length, skipped };
  }

  /**
   * Animated series in Sonarr with aired, monitored episodes that have no file, each with its wco link when one is
   * known, or else the wcostream shows of the same name. Live action is left out: wcostream does not carry it.
   */
  async libraryGaps(catalogue: CatalogueItem[]) {
    const [all, prefs] = await Promise.all([this.allSeriesNow(), this.prefs()]);
    const links = new Map<number, { slug: string; pref: ShowPref }>();
    for (const [slug, pref] of Object.entries(prefs)) {
      const had = links.get(pref.seriesId);
      if (!had || (pref.follow && !had.pref.follow)) links.set(pref.seriesId, { slug, pref });
    }
    const index = indexCatalogue(catalogue);
    const split = await this.splitFolders();
    const root = (p: string) => /^([A-Za-z]:[\\/][^\\/]+|\/[^/]+)/.exec(String(p ?? ''))?.[1] ?? String(p ?? '');
    // A linked show uses its real count (unmonitored episodes included) once it has one, so a show Sonarr calls
    // complete still appears when episodes are missing or in another language only (A Returner's Magic, 11 Nov 2026).
    return all
      .map((s) => {
        const link = links.get(s.id);
        const c = link?.pref.counts;
        const sonarrGaps = Math.max(0, (s.statistics?.episodeCount ?? 0) - (s.statistics?.episodeFileCount ?? 0));
        const undub = link && (link.pref.language ?? 'dub') !== 'sub' ? c?.undub ?? 0 : 0;
        return { s, link, total: (s.statistics?.totalEpisodeCount ?? s.statistics?.episodeCount ?? 0) as number, gaps: c ? c.missing : sonarrGaps, undub };
      })
      .filter((x) => (x.gaps > 0 || x.undub > 0) && (x.link || (x.s.genres ?? []).some((g: string) => g === 'Animation' || g === 'Anime')))
      .map(({ s, link, total, gaps, undub }) => {
        const base = { id: s.id as number, title: s.title as string, year: s.year as number, path: s.path as string, root: root(s.path), gaps, undub, total,
          split: split.get(s.id) ?? [] };
        if (link) return { ...base, state: link.pref.follow ? 'following' : 'linked', slug: link.slug, language: link.pref.language ?? 'dub', candidates: [] as CatalogueMatch[] };
        const m = matchCatalogue(s, index);
        return { ...base, state: m.kind as string, slug: undefined as string | undefined, language: undefined as string | undefined, candidates: m.candidates };
      })
      .sort((a, b) => a.root.localeCompare(b.root) || a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }));
  }

  // ---------- The followed list's Sonarr facts ----------
  // The list itself comes from our own file. Two things in it come from Sonarr: Sonarr's own missing count, for a
  // show we have not counted yet, and a show's second folders. Sonarr's whole series list takes about half a minute
  // on a library of thousands, so the home screen never waits for it: it gets the last known facts at once (kept on
  // disk, so a restart keeps them too) and they are refreshed behind.
  private get factsFile() { return path.join(this.configDir, 'followed-facts.json'); }
  private facts?: FollowedFacts;
  private factsRead = false;
  private factsTried = 0;
  private factsRefresh?: Promise<void>;

  /** Sonarr's address or key was changed in Settings: nothing remembered from the old one may be shown as the new one's. */
  sonarrChanged() {
    this.seriesCache = undefined;
    this.seriesGen++;
    this.seriesFetch = undefined;
    this.splitCache = undefined;
    this.facts = undefined;
    this.factsRead = true;
    this.factsTried = 0;
    void fs.rm(this.factsFile, { force: true }).catch(() => undefined);
  }

  /** True while those facts are being refreshed: the screen asks for the list again until this turns false. */
  get followedRefreshing(): boolean { return !!this.factsRefresh; }

  private async followedFacts(ids: number[]): Promise<FollowedFacts | undefined> {
    if (!this.factsRead) {
      this.factsRead = true;
      try {
        const f = JSON.parse(await fs.readFile(this.factsFile, 'utf8'));
        if (typeof f?.at === 'number' && Array.isArray(f.ids) && f.stats && f.split) this.facts = f;
      } catch { /* none yet, or unreadable: the refresh writes a new one */ }
    }
    const f = this.facts;
    const known = new Set(f?.ids);
    const stale = !f || Date.now() - f.at > FACTS_FRESH_MS || ids.some((id) => !known.has(id));
    // After a failed try, wait a minute: a Sonarr that is down must not be asked on every visit.
    if (stale && ids.length && this.config.sonarrApiKey && !this.factsRefresh && Date.now() - this.factsTried > FACTS_RETRY_MS) {
      this.factsTried = Date.now();
      this.factsRefresh = this.refreshFollowedFacts(ids)
        .catch((err) => this.logger.warn(`Followed list: Sonarr facts not refreshed: ${(err as Error).message}`))
        .finally(() => { this.factsRefresh = undefined; });
    }
    return f;
  }

  private async refreshFollowedFacts(ids: number[]) {
    const all = await this.allSeries();
    const split = await this.splitFolders();
    const want = new Set(ids);
    const facts: FollowedFacts = { at: Date.now(), ids, stats: {}, split: {} };
    for (const s of all) if (want.has(s.id) && s.statistics) facts.stats[s.id] = [s.statistics.episodeCount ?? 0, s.statistics.episodeFileCount ?? 0];
    for (const id of ids) { const folders = split.get(id); if (folders?.length) facts.split[id] = folders; }
    this.facts = facts;
    this.factsTried = 0;
    const tmp = this.factsFile + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(facts));
    await fs.rename(tmp, this.factsFile);
  }

  async followed() {
    const mine = Object.entries(await this.prefs()).filter(([, p]) => p.follow);
    const facts = await this.followedFacts(mine.map(([, p]) => p.seriesId));
    return mine.map(([slug, p]) => {
      // "missing" from Sonarr is its own count: aired, monitored episodes with no file. Japanese-only files are not in it.
      const st = facts?.stats[p.seriesId];
      // A real count (monitored or not) when there is one; else Sonarr's own, which skips unmonitored episodes.
      return { slug, title: p.title, seriesId: p.seriesId, language: p.language ?? 'dub',
        missing: p.counts?.missing ?? (st ? Math.max(0, st[0] - st[1]) : undefined),
        undub: p.language === 'sub' ? 0 : p.counts?.undub, countedAt: p.counts?.at, split: facts?.split[p.seriesId] ?? [],
        unlisted: p.unlisted?.ids.length ?? 0, switchTo: switchTo(p) };
    });
  }

  /** Five past the hour the night window opens (01:05 by default): make the night's plan. */
  @Cron('5 * * * *')
  async nightlyTick() { if (new Date().getHours() === NIGHT.from) await this.nightlyPlan(); }

  private planning?: Promise<void>;
  /** Queue what is due for each followed show. The runs start inside the night window. One plan at a time: a second call joins the one running. */
  nightlyPlan(): Promise<void> {
    return (this.planning ??= this.plan().finally(() => { this.planning = undefined; }));
  }

  private async plan() {
    const prefs = await this.prefs();
    const busy = this.activeIds();
    let budget = SETTINGS.nightBudget;
    // Every followed show is looked at (and counted) first; then the shows with the fewest episodes due are queued
    // first, so new weekly episodes and nearly complete shows are not stuck behind a 200-episode backlog.
    const plans: { slug: string; pref: ShowPref; due: number[] }[] = [];
    const deadline = Date.now() + 30 * 60 * 1000;      // reading wcostream's lists must not eat the night
    const handOff: { slug: string; pref: ShowPref; eps: MapEpisode[] }[] = [];
    for (const [slug, pref] of Object.entries(prefs).filter(([, p]) => p.follow)) {
      try {
        const map = await this.mapEpisodes(pref.seriesId);
        pref.counts = countMap(map);
        const tries = (pref.tries ??= {});
        const due: number[] = [];
        for (const e of map) {
          const work = e.st === 'missing' || (e.st === 'undub' && pref.language !== 'sub');
          if (!work) { delete tries[e.id]; continue; }
          if (busy.has(e.id)) continue;
          const verdict = retryDue(e.a, tries[e.id]);
          if (verdict === 'due') due.push(e.id);
          else if (verdict === 'give-up' && !tries[e.id]?.handedToSonarr && e.st === 'missing') {
            await this.handToSonarr([e.id]);
            tries[e.id] = { ...tries[e.id]!, handedToSonarr: true };
            this.nightNotes.push(`${pref.title ?? slug} ${e.s}x${pad(e.e)}: tried ${RETRY_DAYS.length} times, handed to Sonarr`);
          }
        }
        const kept = await this.dropUnlisted(slug, pref, map, due, tries, deadline, handOff);
        if (kept.length) plans.push({ slug, pref, due: kept });
      } catch (err) {
        this.logger.warn(`Nightly plan for ${slug}: ${(err as Error).message}`);
      }
    }
    // Only when wcostream read properly all through the plan: a page that broke halfway must not hand a library over.
    if (this.wcoVerdict().ok) for (const { slug, pref, eps } of handOff) {
      try {
        await this.handToSonarr(eps.map((e) => e.id));
        for (const e of eps) pref.tries![e.id] = { ...pref.tries![e.id], handedToSonarr: true };
        const codes = eps.map((e) => `${e.s}x${pad(e.e)}`);
        this.nightNotes.push(`${pref.title ?? slug} ${codes.length <= 4 ? codes.join(', ') : `${codes.length} episodes, ${codes[0]} to ${codes[codes.length - 1]}`}: ` +
          `not on wcostream at two checks running, aired over ${UNLISTED_HAND_DAYS} days ago, handed to Sonarr`);
      } catch (err) {
        this.logger.warn(`Handing ${slug} to Sonarr: ${(err as Error).message}`);
      }
    }
    plans.sort((a, b) => a.due.length - b.due.length || (a.pref.lastPlanned ?? '').localeCompare(b.pref.lastPlanned ?? ''));
    for (const { slug, pref, due } of plans) {
      if (budget <= 0) break;
      try {
        const tries = (pref.tries ??= {});
        const job = await this.createJob({ seriesId: pref.seriesId, slug, language: pref.language ?? 'dub',
          absolute: pref.absolute, episodeIds: due.slice(0, Math.min(40, budget)), auto: true });
        budget -= job.episodes.length;
        pref.lastPlanned = new Date().toISOString();
        for (const e of job.episodes) tries[e.id] = { n: (tries[e.id]?.n ?? 0) + 1, last: new Date().toISOString() };
        this.logger.log(`Nightly plan: ${job.episodes.length} episode(s) of ${job.title}`);
      } catch (err) {
        this.logger.warn(`Nightly plan for ${slug}: ${(err as Error).message}`);
      }
    }
    // Only what the plan worked out is written back, onto a fresh read: a follow or link made while it ran stays.
    const planned = Object.entries(prefs).filter(([, p]) => p.follow);
    await this.changePrefs((fresh) => {
      for (const [slug, mine] of planned) {
        const now = fresh[slug];
        if (!now || now.seriesId !== mine.seriesId) continue;
        if (mine.counts) now.counts = mine.counts;
        if (mine.tries) now.tries = mine.tries;
        if (mine.lastPlanned) now.lastPlanned = mine.lastPlanned;
        if (mine.unlisted) now.unlisted = mine.unlisted; else delete now.unlisted;
      }
    });
    void this.pump();
  }

  /**
   * Take out of tonight's list the episodes wcostream does not list for this show (12 Nov 2026: 33 of the first night's
   * 47 failures were "list index out of range", an episode the site does not have under that number). They count as a
   * try, so after the usual four the episode is handed to Sonarr to search for. Unknown (a failed read, or wcostream
   * unreadable) never drops anything. An episode that aired over UNLISTED_HAND_DAYS ago and was not listed at the check
   * before either is unlikely to appear: it goes on the hand-off list for Sonarr now (18 Nov 2026), not after four tries.
   */
  private async dropUnlisted(slug: string, pref: ShowPref, map: MapEpisode[], due: number[], tries: NonNullable<ShowPref['tries']>,
    deadline: number, handOff: { slug: string; pref: ShowPref; eps: MapEpisode[] }[] = []): Promise<number[]> {
    if (!due.length) { delete pref.unlisted; return due; }
    if (!this.wco || Date.now() > deadline) return due;
    const listing = await this.wco.listing(slug, pref.language ?? 'dub');
    if (!listing || !this.wcoVerdict().ok) return due;
    const sources = resolveSources(listing, map, !!pref.absolute);
    const gone = due.filter((id) => sources.get(id)?.kind === 'none');
    if (!gone.length) { delete pref.unlisted; return due; }
    const now = new Date().toISOString();
    const before = new Set(pref.unlisted?.ids ?? []);
    const oldBefore = new Date(Date.now() - UNLISTED_HAND_DAYS * 86400000).toISOString().slice(0, 10);
    const hand = map.filter((e) => gone.includes(e.id) && before.has(e.id) && e.st === 'missing' && e.a && e.a <= oldBefore && !tries[e.id]?.handedToSonarr);
    if (hand.length) handOff.push({ slug, pref, eps: hand });
    for (const id of gone) tries[id] = { ...tries[id], n: (tries[id]?.n ?? 0) + 1, last: now };
    pref.unlisted = { ids: gone, at: now };
    this.logger.log(`${pref.title ?? slug}: ${gone.length} episode(s) not listed on wcostream, left out`);
    return due.filter((id) => !gone.includes(id));
  }

  // ---------- Numbering check ----------
  private scan = { running: false, done: 0, total: 0, startedAt: '' };

  /** Check every followed show that has work: does the site list more of it under the other way of numbering? Runs in the background. */
  startNumberingScan() {
    if (this.scan.running || !this.wco) return this.scan;
    this.scan = { running: true, done: 0, total: 0, startedAt: new Date().toISOString() };
    void (async () => {
      try {
        const slugs = Object.entries(await this.prefs()).filter(([, p]) => p.follow).map(([slug]) => slug);
        this.scan.total = slugs.length;
        for (const slug of slugs) {
          try {
            const pref = (await this.prefs())[slug];
            if (pref) {
              const map = await this.mapEpisodes(pref.seriesId);
              const work = new Set(map.filter((e) => e.st === 'missing' || (e.st === 'undub' && pref.language !== 'sub')).map((e) => e.id));
              const listing = work.size ? await this.wco!.listing(slug, pref.language ?? 'dub') : undefined;
              await this.changePrefs((fresh) => {
                if (!fresh[slug]) return;
                if (listing && this.wcoVerdict().ok) fresh[slug].numbering = { ...numberingFit(listing, map, work, !!fresh[slug].absolute), at: new Date().toISOString() };
                else if (!work.size) delete fresh[slug].numbering;
              });
            }
          } catch (err) { this.logger.warn(`Numbering check for ${slug}: ${(err as Error).message}`); }
          this.scan.done++;
        }
      } finally { this.scan.running = false; }
    })();
    return this.scan;
  }

  async numbering() {
    const prefs = await this.prefs();
    const rows = Object.entries(prefs).filter(([, p]) => p.follow && p.numbering)
      .map(([slug, p]) => ({ slug, title: p.title ?? slug, seriesId: p.seriesId, mode: p.absolute ? 'absolute' : 'season', language: p.language ?? 'dub', fit: p.numbering!, switchTo: switchTo(p) }));
    return { scan: this.scan, rows };
  }

  /** For the map: which episodes that need work does wcostream not list? Reads the show page (cached six hours). */
  async wcoCheck(link: string, seriesIdParam?: string, langParam?: string, absoluteParam?: string) {
    let parsed;
    try { parsed = parseShowLink(link); } catch (e) { throw new BadRequestException((e as Error).message); }
    const none = { checked: false, unlisted: [] as number[], latest: '' };
    if (!this.wco) return none;
    const prefs = await this.prefs();
    const seriesId = seriesIdParam ? Number(seriesIdParam) : prefs[parsed.slug]?.seriesId;
    if (!seriesId) return none;
    const language = langParam === 'sub' || langParam === 'dub' ? langParam : prefs[parsed.slug]?.language ?? 'dub';
    const absolute = absoluteParam !== undefined ? absoluteParam === 'true' : !!prefs[parsed.slug]?.absolute;
    const listing = await this.wco.listing(parsed.slug, language);
    if (!listing || !this.wcoVerdict().ok) return none;
    const map = await this.mapEpisodes(seriesId);
    const sources = resolveSources(listing, map, absolute);
    const work = map.filter((e) => e.st === 'missing' || e.st === 'undub' || e.st === 'unknown');
    const gone = work.filter((e) => sources.get(e.id)?.kind === 'none');
    // Episodes the site has inside a link that holds several: the map says which go together.
    const together: Record<number, number[]> = {};
    for (const e of map) { const s = sources.get(e.id); if (s?.kind === 'title' && s.ids.length > 1) together[e.id] = s.ids; }
    const other = { ...numberingFit(listing, map, new Set(work.filter((e) => e.st !== 'unknown').map((e) => e.id)), absolute) };
    return { checked: true, unlisted: gone.map((e) => e.id), different: gone.filter((e) => (sources.get(e.id) as any).why === 'different').length,
      byTitle: work.filter((e) => sources.get(e.id)?.kind === 'title').length, together, fit: other,
      latest: latestText(listing), language, listed: listing.count };
  }

  /**
   * Calendar rows with what the screen needs to act on them: for a show in Sonarr, whether it is followed and which
   * wcostream show it would follow; for one that is not, whether wcostream carries it. Also the latest episode
   * wcostream lists for shows airing now (read in the background; what is not read in 20 seconds shows next time).
   */
  /** True while show listings the calendar asked for are still being fetched from wcostream. */
  get calendarWarming(): boolean { return this.warming > 0; }
  private warming = 0;

  async calendarInfo<T extends { seriesId?: number; title: string; date: string; estimate: boolean }>(rows: T[], catalogue: CatalogueItem[]) {
    const [all, prefs] = await Promise.all([this.allSeriesNow(), this.prefs()]);
    const bySeries = new Map(all.map((s) => [s.id, s]));
    const links = new Map<number, { slug: string; pref: ShowPref }>();
    for (const [slug, pref] of Object.entries(prefs)) {
      const had = links.get(pref.seriesId);
      if (!had || (pref.follow && !had.pref.follow)) links.set(pref.seriesId, { slug, pref });
    }
    const index = indexCatalogue(catalogue);
    const soon = Date.now() + 7 * 86400000, recent = Date.now() - 3 * 86400000;
    const warm: Promise<unknown>[] = [];
    const info = new Map<string, any>();
    const out = rows.map((r) => {
      const key = r.seriesId ? `s${r.seriesId}` : `t${r.title}`;
      if (!info.has(key)) {
        if (r.seriesId) {
          const link = links.get(r.seriesId);
          if (link) {
            const language = link.pref.language ?? 'dub';
            const t = new Date(r.date).getTime();
            if (this.wco && !r.estimate && t < soon && t > recent && !this.wco.peek(link.slug, language)) warm.push(this.wco.listing(link.slug, language));
            info.set(key, { slug: link.slug, follow: !!link.pref.follow, language, linkLanguage: language });
          } else {
            const s = bySeries.get(r.seriesId);
            const m = s ? matchCatalogue(s, index) : { kind: 'none' as const, candidates: [] as CatalogueMatch[] };
            info.set(key, { follow: false, wcoState: m.kind, candidates: m.candidates });
          }
        } else {
          const m = matchCatalogue({ id: 0, title: r.title } as any, index);
          info.set(key, { follow: false, onWco: m.kind !== 'none' });
        }
      }
      return { r, key };
    });
    // Fetched behind the answer, not waited for (that wait was most of the calendar's 24 seconds): the screen asks
    // again while calendarWarming is true and picks up "latest on wcostream" as each listing arrives.
    if (warm.length) {
      this.warming++;
      void Promise.allSettled(warm).finally(() => { this.warming--; });
    }
    return out.map(({ r, key }) => {
      const i = info.get(key);
      const listing = i.slug && this.wco ? this.wco.peek(i.slug, i.language) : undefined;
      return { ...r, ...i, wcoLatest: listing ? latestText(listing) : undefined };
    });
  }

  /** Every 10 minutes: start any automatic runs that are waiting for the night window. */
  @Cron('*/10 * * * *')
  wake() { if (isNight()) void this.pump(); }

  private nightNotes: string[] = [];

  /** One summary POST to NOTIFY_URL (when set) once the night's automatic runs have finished. */
  private async notifyNight() {
    const { publicUrl } = this.config;
    const since = Date.now() - 20 * 3600 * 1000;
    const runs = this.jobs.filter((j) => j.auto && new Date(j.createdAt).getTime() > since);
    const n = (st: string) => runs.reduce((a, j) => a + j.episodes.filter((e) => e.state === st).length, 0);
    const swaps = runs.reduce((a, j) => a + j.episodes.filter((e) => e.state === 'done' && e.mode === 'swap').length, 0);
    const shows = [...new Set(runs.filter((j) => j.episodes.some((e) => e.state === 'done')).map((j) => j.title))];
    const body = `Overnight: ${n('done') - swaps} filled, ${swaps} swapped to dub, ${n('premium')} premium to Sonarr, ${n('kept')} to check, ${n('failed')} failed.` +
      (shows.length ? `\nShows: ${shows.slice(0, 8).join(', ')}.` : '') +
      (this.nightNotes.length ? '\n' + this.nightNotes.splice(0).slice(0, 5).join('\n') : '') +
      (await this.attention().then((a) => (a.length ? `\n${a.length} need you: open the link.` : ''), () => ''));
    const disk = await this.checkDisk();
    const wco = this.wcoVerdict();
    if (!wco.ok) { this.wcoToldAt = Date.now(); this.wcoTold = true; this.wcoPending = false; }
    const stage = await this.staging().catch(() => undefined);
    const text = body + (disk.low ? `\n${lowDiskMessage(disk)}.` : '') + (wco.ok ? '' : `\nwcostream cannot be read: ${wco.why}. ${WCO_HELD}`) +
      (stage?.old.files ? `\n${stage.old.folders} downloads in staging untouched for ${STAGE_OLD_DAYS} days (${gb(stage.old.bytes)}): delete them on Needs you.` : '');
    this.logger.log(text.replace(/\n/g, ' | '));
    await this.push('wco-dl overnight', text, publicUrl ? `${publicUrl}/map.html#attention` : undefined);
  }

  /** One message to NOTIFY_URL (when set): {source, title, body, url}, with NOTIFY_TOKEN as x-notify-token. */
  private async push(title: string, body: string, url?: string) {
    const { notifyUrl, notifyToken } = this.config;
    if (!notifyUrl) return;
    await axios.post(notifyUrl, { source: 'wco-dl', title, body, url },
      { headers: notifyToken ? { 'x-notify-token': notifyToken } : {}, timeout: 30000 });
  }

  // ---------- New dubs (17 Nov 2026) ----------
  /** During the day, four times: see checkNewDubs. The night run reads the same pages for its own plan. */
  @Cron('0 10,14,18,22 * * *')
  async newDubsCron() {
    if (isNight()) return;
    if (this.wcoPending) {      // went unreadable in the night and no summary said so
      const v = this.wcoVerdict();
      this.wcoPending = false;
      if (!v.ok) await this.tellWco(v).catch((e) => this.logger.warn(`wcostream message failed: ${(e as Error).message}`));
    }
    await this.checkNewDubs().catch((e) => this.logger.warn(`New-dub check: ${(e as Error).message}`));
  }

  /**
   * Has wcostream listed in English an episode a followed dub show is waiting for? Only shows with an episode aired in
   * the last three weeks and no English file are looked at (one Sonarr calendar call finds them), so this is a handful
   * of page reads, not one per followed show. Each episode is told once; the overnight run fills it either way.
   */
  async checkNewDubs(now = new Date()): Promise<{ show: string; slug: string; seriesId: number; episodes: string[] }[]> {
    if (!this.wco || !this.config.sonarrApiKey) return [];
    const bySeries = new Map<number, [string, ShowPref]>();
    for (const [slug, p] of Object.entries(await this.prefs())) if (p.follow && (p.language ?? 'dub') === 'dub') bySeries.set(p.seriesId, [slug, p]);
    if (!bySeries.size) return [];
    const from = new Date(now.getTime() - NEW_DUB_DAYS * 86400000);
    const cal = await this.sonarr<any[]>('get', `calendar?start=${from.toISOString()}&end=${now.toISOString()}&unmonitored=true&includeEpisodeFile=true`);
    const waiting = new Set<number>();
    for (const e of cal ?? []) {
      if (!bySeries.has(e.seriesId) || !(e.seasonNumber > 0)) continue;
      if (!e.hasFile || audioStatus(e.episodeFile?.mediaInfo?.audioLanguages ?? '') === 'undub') waiting.add(e.seriesId);
    }
    const found: { show: string; slug: string; seriesId: number; episodes: string[]; ids: number[] }[] = [];
    const day = (d: string) => (d ? new Date(d.length === 10 ? d + 'T12:00:00Z' : d).getTime() : NaN);
    for (const seriesId of waiting) {
      const [slug, pref] = bySeries.get(seriesId)!;
      try {
        const told = new Set(pref.announced ?? []);
        const map = await this.mapEpisodes(seriesId);
        const due = map.filter((e) => (e.st === 'missing' || e.st === 'undub') && !told.has(e.id) && day(e.a) >= from.getTime() && day(e.a) <= now.getTime());
        if (!due.length) continue;
        const listing = await this.wco.listing(slug, 'dub');
        if (!listing) continue;
        const sources = resolveSources(listing, map, !!pref.absolute);
        const there = due.filter((e) => { const s = sources.get(e.id); return !!s && s.kind !== 'none'; });
        if (there.length) found.push({ show: pref.title ?? slug, slug, seriesId, ids: there.map((e) => e.id), episodes: there.map((e) => `${e.s}x${pad(e.e)}`) });
      } catch (err) { this.logger.warn(`New-dub check for ${slug}: ${(err as Error).message}`); }
    }
    if (!found.length) return [];
    await this.changePrefs((fresh) => {
      for (const f of found) if (fresh[f.slug]) fresh[f.slug].announced = [...(fresh[f.slug].announced ?? []), ...f.ids].slice(-300);
    });
    const hh = (h: number) => String(h).padStart(2, '0') + ':00';
    const body = `In English on wcostream now: ${found.slice(0, 8).map((f) => `${f.show} ${f.episodes.join(', ')}`).join('; ')}` +
      (found.length > 8 ? `; and ${found.length - 8} more shows` : '') + '.' +
      `\nThe overnight run (${hh(NIGHT.from)} to ${hh(NIGHT.to)}) fills them; open the map to fill one now.`;
    this.logger.log(body.replace(/\n/g, ' | '));
    const { publicUrl } = this.config;
    const url = publicUrl ? `${publicUrl}/map.html` + (found.length === 1 ? `?url=${encodeURIComponent(found[0].slug)}` : '') : undefined;
    await this.push(found.length === 1 ? `New dub: ${found[0].show}` : `New dubs: ${found.length} shows`, body, url)
      .catch((e) => this.logger.warn(`New-dub message failed: ${(e as Error).message}`));
    return found.map(({ ids, ...f }) => f);
  }

  /** The downloader's own output for one episode of a run, for the queue view. */
  async episodeLog(jobId: string, episodeId: number): Promise<string> {
    const job = this.getJob(jobId);
    const ep = job.episodes.find((e) => e.id === episodeId);
    if (!ep) throw new NotFoundException('No such episode in this run');
    const text = await fs.readFile(path.join(this.stageDir(job, ep), 'downloader.log'), 'utf8').catch(() => '');
    const lines = text.split(/\r?\n|\r/).filter((l) => l.trim() && !/^DEBUG|confidence =/.test(l));
    return lines.slice(-150).join('\n') || 'No downloader output was kept for this episode.';
  }

  // ---------- Staging (18 Nov 2026) ----------
  /**
   * Downloads left in staging by kept and failed episodes, one folder per show and episode. "Old" folders were last
   * touched over STAGE_OLD_DAYS ago and belong to no episode waiting or running; Needs you offers to delete them.
   * A kept file is not imported for a reason (wrong episode, not a dub, will not play), so it is rarely wanted later.
   */
  async staging(now = Date.now()) {
    const root = path.join(this.config.outputBase, 'wco-gaps');
    const busy = this.busyStageDirs();
    const all = { files: 0, bytes: 0 }, old = { folders: 0, files: 0, bytes: 0 }, dirs: string[] = [];
    for (const show of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!show.isDirectory()) continue;
      for (const e of await fs.readdir(path.join(root, show.name), { withFileTypes: true }).catch(() => [])) {
        if (!e.isDirectory()) continue;
        const dir = path.join(root, show.name, e.name), st = await dirStats(dir);
        all.files += st.files; all.bytes += st.bytes;
        if (busy.has(dir) || now - (st.newest || 0) < STAGE_OLD_DAYS * 86400000) continue;
        old.folders++; old.files += st.files; old.bytes += st.bytes; dirs.push(dir);
      }
    }
    return { ...all, days: STAGE_OLD_DAYS, old, dirs };
  }

  /** Delete the old folders in staging; an episode queued meanwhile keeps its own. */
  async clearStaging() {
    const s = await this.staging();
    let folders = 0, bytes = 0;
    for (const dir of s.dirs) {
      if (this.busyStageDirs().has(dir)) continue;
      const st = await dirStats(dir);
      try { await fs.rm(dir, { recursive: true, force: true }); folders++; bytes += st.bytes; } catch { /* in use: left */ }
      await fs.rmdir(path.dirname(dir)).catch(() => undefined);     // only when the show's folder is now empty
    }
    this.logger.log(`Staging: deleted ${folders} old download folder(s), ${gb(bytes)}`);
    return { folders, bytes };
  }

  private busyStageDirs() {
    return new Set(this.jobs.flatMap((j) => j.episodes.filter((e) => ['queued', 'downloading', 'importing'].includes(e.state)).map((e) => this.stageDir(j, e))));
  }

  private stageDir(job: FillJob, ep: FillEpisode) {
    return path.join(this.config.outputBase, 'wco-gaps', job.slug + (job.language ? '-' + job.language : ''), `S${pad(ep.s)}E${pad(ep.e)}`);
  }

  /** Retry: kept and failed episodes go back in the queue; a matching file already in staging is imported
   *  without downloading again ("Import from staging"). */
  async retry(jobId: string) {
    const job = this.getJob(jobId);
    const busy = this.activeIds();
    for (const ep of job.episodes) {
      if ((ep.state === 'kept' || ep.state === 'failed' || ep.state === 'cancelled') && !busy.has(ep.id)) { ep.state = 'queued'; ep.message = undefined; }
    }
    await this.save();
    void this.pump();
    return job;
  }
}

function pad(n: number) { return String(n).padStart(2, '0'); }

/** The other way of numbering, when the last check found it would supply clearly more of the show's work. */
function switchTo(p: { absolute?: boolean; numbering?: NumberingFit }): 'absolute' | 'season' | undefined {
  const n = p.numbering;
  if (!n || typeof n.byTitle !== 'number') return undefined;
  if (p.absolute) return n.season > n.absolute + 2 ? 'season' : undefined;
  return n.flat && n.absolute > n.season + 2 ? 'absolute' : undefined;
}

/** How many aired episodes have no file, and how many files are Japanese-only, in a show's episode map. */
function countMap(map: { st: string }[]) {
  return { missing: map.filter((e) => e.st === 'missing').length, undub: map.filter((e) => e.st === 'undub').length, at: new Date().toISOString() };
}

/** The video host answered with an error page instead of the video (a dead or overloaded host for that show). */
export const VIDEO_REFUSED = /returned HTTP (4\d\d|5\d\d)|instead of a video/i;
/** This many refusals in a row and the rest of the run waits: 1 hour, then 2, 4, up to 6. */
export const REFUSED_LIMIT = 5;
/** wcostream has the show but no episode under this season and number, or no episodes in this language at all. */
export const NOT_LISTED = /No episode matches|No episodes found|list index out of range|does not list this episode|is another episode/i;

/**
 * What a parked episode says. An overnight run whose wait ends outside the night window does not start again at that
 * time but on the next night, so it must not name the time (13 Nov 2026: "wait until 07:35" on runs idle all day).
 */
export function brakeMessage(refused: number, until: Date, auto: boolean): string {
  const head = `wcostream's video server refused ${refused} episodes of this show in a row; the rest wait `;
  return head + (auto && !isNight(until) ? 'for the next overnight run' : `until ${until.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`);
}

/** Minutes to wait after each "servers busy" answer before trying the episode again. */
export const BUSY_WAIT_MIN = [5, 15, 45];

/** The downloader's own reason for a failure, in a sentence: its last specific complaint, not its summary line. */
export function failureReason(text: string): string {
  const lines = text.split(/[\r\n]+/).map((l) => l.replace(/^\[wco-dl\] - /, '').trim()).filter(Boolean);
  const specific = [...lines].reverse().find((l) => /^(Could not|Error|Embed player|Skipping|No episode)|Traceback|refused|timed out|returned HTTP \d+/i.test(l) && !/episode\(s\) (downloaded|failed)/.test(l));
  // A video address is one long token: name the server instead. Other addresses keep their last part, without the query.
  let why = (specific ?? lines.filter((l) => !/^DEBUG/.test(l)).pop() ?? 'no output')
    .replace(/https?:\/\/\S*getvid\S*/g, "wcostream's video server")
    .replace(/https?:\/\/\S+/g, (u) => u.split('?')[0].split('/').filter(Boolean).pop() ?? u);
  if (/list index out of range/i.test(why)) why = 'wcostream does not list this episode under this season and number';
  return 'Not downloaded: ' + (why.length > 220 ? '…' + why.slice(-200) : why);
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function lastLine(text: string) {
  return text.split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !/^DEBUG/.test(l)).pop()?.slice(0, 200);
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...(await listFiles(p)));
    else out.push(p);
  }
  return out;
}

/** What ffprobe says about a file; undefined when there is no ffprobe to ask (or it hung), which never blocks an import. */
async function probeFile(file: string): Promise<Probe | undefined> {
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type',
      '-of', 'json', file], { timeout: 60000 });
    const j = JSON.parse(stdout);
    const seconds = Number(j.format?.duration);
    return { read: true, video: (j.streams ?? []).some((s: any) => s.codec_type === 'video'), seconds: Number.isFinite(seconds) ? seconds : undefined };
  } catch (e: any) {
    if (e?.code === 'ENOENT' || e?.killed) return undefined;
    return { read: false, video: false };
  }
}

async function audioTags(file: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries',
      'stream_tags=language', '-of', 'json', file], { timeout: 60000 });
    return (JSON.parse(stdout).streams ?? []).map((s: any) => String(s.tags?.language ?? 'und').toLowerCase());
  } catch {
    return [];
  }
}
