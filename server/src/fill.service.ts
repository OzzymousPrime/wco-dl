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

const WCO_HELD = 'Until it reads again, downloads wait, no episode counts as missing from wcostream and none goes to Sonarr for that reason.';
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
import { fileIsEpisode, fileTitle, latestText, linkCheck, linkTitle, numberingFit, NumberingFit, pickedBy, resolveSources, Source } from './wco-episodes.util';

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
  /** Planned by "Fill now" (18 Nov 2026): an automatic run that starts straight away instead of waiting for the night. */
  now?: boolean;
  /** The link's wcostream show is this Sonarr season (21 Nov 2026), numbered from 1 on the site. */
  season?: number;
  /** Episodes in a row that wcostream's video server refused (see VIDEO_REFUSED). */
  refused?: number;
  /** Episodes a run summary has already counted (19 Nov 2026), so an episode parked past the night is told once, later. */
  told?: number[];
}

/** Episodes to hand to Sonarr tonight, with the reason for the summary. `unlisted`: only while wcostream reads properly. */
interface HandOff { slug: string; pref: ShowPref; eps: MapEpisode[]; why: string; unlisted?: boolean }

/** One season of a series, numbered from 1 as a wcostream show of that season numbers it (21 Nov 2026). */
export function seasonView<T extends { s: number; e: number; abs?: number }>(map: T[], season: number): T[] {
  return map.filter((e) => e.s === season).map((e) => ({ ...e, abs: e.e }));
}

/** Which handed-over episodes are searched for tonight: the newest `cap` by air date; the rest are only monitored. */
export function newestIds(groups: { id: number; a?: string }[][], cap: number): Set<number> {
  return new Set(groups.flat().sort((x, y) => (y.a ?? '').localeCompare(x.a ?? '') || y.id - x.id).slice(0, cap).map((e) => e.id));
}

/** What a set of automatic runs did, in all and per show. */
export interface RunTally { filled: number; swapped: number; premium: number; kept: number; failed: number }
/** Why an episode failed or was kept, in a word (19 Nov 2026): for the summary, the attempt log and the next review. */
export type FailureKind = 'blocked' | 'refused' | 'no-player' | 'unlisted' | 'misnamed' | 'not-dub' | 'unplayable' | 'stalled' | 'other';
export function failureKind(message = ''): FailureKind {
  if (BLOCKED.test(message)) return 'blocked';
  if (VIDEO_REFUSED.test(message)) return 'refused';
  if (NO_PLAYER.test(message)) return 'no-player';
  if (NOT_LISTED.test(message)) return 'unlisted';
  if (/which is not \d+x\d+|a different episode/i.test(message)) return 'misnamed';
  if (/Not a dub/i.test(message)) return 'not-dub';
  if (/would not open|no video|runs \d+ minutes/i.test(message)) return 'unplayable';
  if (/stalled/i.test(message)) return 'stalled';
  return 'other';
}
/**
 * The summary of the last automatic runs (18 Nov 2026), kept for the home screen's "Last night" card, because the
 * phone message is gone once it is swiped away. `kind` is 'now' when every run in it came from "Fill now".
 */
export interface LastRun {
  at: string; from: string; kind: 'night' | 'now'; tally: RunTally;
  shows: ({ slug: string; title: string; seriesId: number; why?: Partial<Record<FailureKind, number>> } & RunTally)[];
  notes: string[]; attention: number;
  /** Why episodes failed or were kept, by kind; and how many were still waiting (parked past the night) when told. */
  reasons?: Partial<Record<FailureKind, number>>; waiting?: number;
}
/** Count what runs did, in all and per show (a show with two runs is one row), shows by name. */
/** Count what runs did, in all and per show (a show with two runs is one row), shows by name. `skip`: episodes already told. */
export function tallyRuns(runs: FillJob[], skip: (j: FillJob, id: number) => boolean = () => false):
  { tally: RunTally; shows: LastRun['shows']; reasons: Partial<Record<FailureKind, number>>; waiting: number } {
  const zero = (): RunTally => ({ filled: 0, swapped: 0, premium: 0, kept: 0, failed: 0 });
  const tally = zero(), by = new Map<number, LastRun['shows'][number]>(), reasons: Partial<Record<FailureKind, number>> = {};
  let waiting = 0;
  for (const j of runs) {
    const row = by.get(j.seriesId) ?? { slug: j.slug, title: j.title, seriesId: j.seriesId, ...zero() };
    for (const e of j.episodes) {
      if (e.state === 'queued') { waiting++; continue; }
      if (skip(j, e.id)) continue;
      const k: keyof RunTally | undefined = e.state === 'done' ? (e.mode === 'swap' ? 'swapped' : 'filled')
        : e.state === 'premium' ? 'premium' : e.state === 'kept' ? 'kept' : e.state === 'failed' ? 'failed' : undefined;
      if (k) { row[k]++; tally[k]++; }
      if (k === 'failed' || k === 'kept') {
        const why = failureKind(e.message);
        reasons[why] = (reasons[why] ?? 0) + 1;
        (row.why ??= {})[why] = (row.why[why] ?? 0) + 1;
      }
    }
    by.set(j.seriesId, row);
  }
  const shows = [...by.values()].filter((r) => r.filled + r.swapped + r.premium + r.kept + r.failed > 0)
    .sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }));
  return { tally, shows, reasons, waiting };
}

interface ShowPref {
  seriesId: number; absolute?: boolean;
  /** Followed: the nightly plan fills its gaps (and swaps to the dub when language is dub). */
  follow?: boolean; language?: 'dub' | 'sub'; title?: string; lastPlanned?: string;
  /** Per episode: how many nightly attempts so far and when the last one was. */
  tries?: { [episodeId: string]: Try };
  /**
   * From the last count (the nightly plan, a look-up, or "Recount"): aired episodes with no file, monitored or not, and
   * Japanese-only files. `onWco`: of those, how many wcostream lists, from the last night it was read (18 Nov 2026).
   */
  counts?: { missing: number; undub: number; at: string; onWco?: number; wcoAt?: string };
  /** The link looks like another show (see linkCheck): left out of the plan until fixed, or confirmed with linkOk. */
  linkWrong?: { why: string; at: string };
  /** Someone said the link is right: the link check leaves it alone. */
  linkOk?: boolean;
  /**
   * The wcostream show is this one season of the Sonarr series (21 Nov 2026). Sonarr keeps Pokémon and JoJo as one
   * series in many seasons; wcostream has a show per era or part, each numbered from 1. The link then sees only that
   * season, and its episode N is that season's episode N (straight-through numbering, so `absolute` is set with it).
   */
  season?: number;
  /** Episodes the last night's plan found wcostream does not list (so were not queued). */
  unlisted?: { ids: number[]; at: string };
  /** From the last numbering check: how many episodes that need work the site lists under each way of numbering. */
  numbering?: NumberingFit & { at: string };
  /** Episodes already announced as new on wcostream in English (the new-dub check), so each is told once. */
  announced?: number[];
}
interface ShowPrefs { [slug: string]: ShowPref }
/**
 * One episode's attempts. `dead`: nights on which the video could not be had (the video server refused it, or the
 * page had no player, 18 Nov 2026); on the second such night the episode goes to Sonarr instead of four tries.
 */
export interface Try { n: number; last: string; handedToSonarr?: boolean; dead?: { n: number; day: string } }

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
/** A run may start now: one a person queued, one "Fill now" planned, or an overnight one inside the night window. */
export const mayRun = (j: FillJob) => !j.auto || !!j.now || isNight();
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
/**
 * Episodes handed to Sonarr are all marked monitored, but searched for at most this many a night, newest first
 * (18 Nov 2026: about 3,600 old episodes reached the early hand-off at once; one search each would flood the indexers).
 * The rest are picked up by Sonarr's own feed checks, or its "Search all missing".
 */
export const HAND_SEARCH_PER_NIGHT = 60;
/** A followed show of which wcostream lists none of the missing episodes is read again after this many days, or when one airs. */
export const NONE_ON_WCO_DAYS = 3;
/** The kinds of failure in words, for the summary and the home screen. */
export const KIND_WORDS: Record<FailureKind, string> = {
  blocked: 'blocked (wcostream could not be read)', refused: 'refused by the video server', 'no-player': 'with no video player (premium or removed)', unlisted: 'not listed on wcostream',
  misnamed: 'named as another episode', 'not-dub': 'not a dub', unplayable: 'would not play or too short', stalled: 'stalled', other: 'other',
};
/** The attempt log is started again (the old one kept as .1) past this size. */
const ATTEMPT_LOG_MAX = 5 * 1024 * 1024;
/** The page has no video player for the episode: usually premium-only, or removed. */
export const NO_PLAYER = /No video player iframe found|No stream server available/i;
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
    // Failed only because wcostream could not be read (21 Nov 2026: 274 in two runs while FlareSolverr was down): queued
    // again, so the night or the queue takes them as if nothing had happened. Only the last week, and each once.
    const week = Date.now() - 7 * 86400000;
    let again = 0;
    for (const j of this.jobs) {
      if (new Date(j.createdAt).getTime() < week) continue;
      for (const e of j.episodes) if (e.state === 'failed' && BLOCKED.test(e.message ?? '') && !e.dismissed) {
        e.state = 'queued'; e.message = 'Queued again: wcostream could not be read when it ran'; again++;
        if (j.told) j.told = j.told.filter((id) => id !== e.id);
      }
    }
    if (again) { this.logger.log(`Queued again ${again} episode(s) that failed only because wcostream could not be read`); await this.save(); }
    try { this.paused = !!JSON.parse(await fs.readFile(this.stateFile, 'utf8')).paused; } catch { this.paused = false; }
    try { this.applySettings(cleanSettings(JSON.parse(await fs.readFile(this.settingsFile, 'utf8')))); } catch { /* defaults */ }
    const health = this.wco?.health;
    if (health) health.onChange = (v) => void this.tellWco(v).catch((e) => this.logger.warn(`wcostream message failed: ${(e as Error).message}`));
    void this.pump();
  }

  // ---------- Queue controls ----------
  async queueState() {
    const disk = await this.checkDisk();
    return { paused: this.paused, night: isNight(), nightBudget: SETTINGS.nightBudget, disk, wco: this.wcoVerdict(), links: this.linkProgress() };
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
      try { counted.set(slug, countMap(await this.mapEpisodes(pref.seriesId, pref.season))); }
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
    // An episode's own link (18 Nov 2026): open its show, and say which episode was pasted so the map can pick it.
    // The show is the one whose kept listing holds the link, else the one its name starts with.
    const pick = parsed.episode;
    if (pick) parsed = { ...parsed, slug: this.wco?.ownerOf(pick.link) ?? parsed.slug };
    const prefs = await this.prefs();
    let all = await this.allSeriesNow();
    let seriesId = seriesIdParam ? Number(seriesIdParam) : prefs[parsed.slug]?.seriesId;
    // Added in Sonarr since the list was fetched: ask again rather than say it is not there.
    if (seriesId && !all.some((s) => s.id === seriesId)) all = await this.fetchSeries();
    const candidates = matchSeries(parsed.slug, all);
    if (!seriesId && candidates.length === 1) seriesId = candidates[0].id;
    const brief = (s: any) => ({ id: s.id, title: s.title, year: s.year, path: s.path });
    if (!seriesId) {
      return { slug: parsed.slug, language: parsed.language, series: null, candidates: candidates.map(brief), episodes: [], ...(pick ? { pick } : {}) };
    }
    const series = all.find((s) => s.id === seriesId) ?? (await this.sonarr('get', `series/${seriesId}`));
    let absolute = prefs[parsed.slug]?.absolute ?? false;
    if (absoluteParam !== undefined && !prefs[parsed.slug]?.season) absolute = absoluteParam === 'true';
    const slug = parsed.slug;
    let pref = prefs[slug];
    if (seriesIdParam || absoluteParam !== undefined || !pref) {
      const link = { seriesId, absolute, title: series.title as string };
      pref = (await this.changePrefs((p) => {
        const was = p[slug];
        // Another series or numbering: what wcostream was counted to have no longer holds (21 Nov 2026).
        if (was?.counts && (was.seriesId !== seriesId || !!was.absolute !== absolute)) { delete was.counts.onWco; delete was.counts.wcoAt; }
        p[slug] = { ...p[slug], ...link };
      }))[slug];
      if (seriesIdParam || !prefs[slug]) this.checkLinks([slug]);     // a new link: checked at once (19 Nov 2026)
    }
    const episodes = await this.mapEpisodes(seriesId, pref?.season);
    if (pref?.follow) {                 // keep the home list's counts fresh for a show that was just looked at
      const counts = countMap(episodes);
      await this.changePrefs((p) => { if (p[slug]) p[slug].counts = counts; });
    }
    return {
      slug: parsed.slug, language: parsed.language, series: brief(series), absolute,
      follow: !!pref?.follow, followLanguage: pref?.language ?? 'dub', season: pref?.season,
      seasons: [...new Set((await this.mapEpisodes(seriesId)).map((e) => e.s))],
      candidates: candidates.map(brief), episodes, split: (await this.splitFolders()).get(seriesId) ?? [],
      ...(pick ? { pick } : {}),
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

  private async mapEpisodes(seriesId: number, season?: number): Promise<MapEpisode[]> {
    const all = await this.mapAllEpisodes(seriesId);
    return season ? seasonView(all, season) : all;
  }

  private async mapAllEpisodes(seriesId: number): Promise<MapEpisode[]> {
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

  async createJob(body: { seriesId?: number; slug?: string; language?: string; quality?: string; absolute?: boolean; episodeIds?: number[]; auto?: boolean; now?: boolean }) {
    const seriesId = Number(body?.seriesId);
    const ids = Array.isArray(body?.episodeIds) ? body.episodeIds.map(Number).filter(Number.isFinite) : [];
    if (!seriesId || !ids.length) throw new BadRequestException('Pick a show and at least one episode');
    if (ids.length > 200) throw new BadRequestException('At most 200 episodes per run');
    const slug = parseShowLink(String(body.slug ?? '')).slug;
    const language = body.language === 'dub' || body.language === 'sub' ? body.language : undefined;
    const quality = body.quality === '480' || body.quality === '1080' ? body.quality : SETTINGS.quality;
    const season = (await this.prefs())[slug]?.season;
    const map = await this.mapEpisodes(seriesId, season);
    const series = await this.sonarr('get', `series/${seriesId}`);
    // An automatic run never touches a file whose audio is not labelled; a person may pick one on the map.
    const swappable = (st: EpisodeStatus) => st === 'undub' || (st === 'unknown' && !body.auto);
    const needed = map.filter((e) => ids.includes(e.id) && (e.st === 'missing' || (swappable(e.st) && language !== 'sub')));
    if (!needed.length) throw new BadRequestException('None of those episodes needs work');
    const busy = this.activeIds();
    const picked = needed.filter((e) => !busy.has(e.id));
    if (!picked.length) throw new ConflictException('Those episodes are already in the queue');
    const job: FillJob = {
      id: randomUUID(), seriesId, title: series.title, slug, language, quality, absolute: !!body.absolute || !!season, auto: !!body.auto, ...(body.auto && body.now ? { now: true } : {}),
      ...(season ? { season } : {}),
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
      if (new Date(job.createdAt).getTime() < since || !mayRun(job)) continue;
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

  private probedAt = 0;
  /** While wcostream cannot be read: one fresh read of the next run's show, at most every ten minutes. True when it reads. */
  private async probeWco(job: FillJob): Promise<boolean> {
    if (!this.wco || Date.now() - this.probedAt < 10 * 60 * 1000) return this.wcoVerdict().ok;
    this.probedAt = Date.now();
    await this.wco.listing(job.slug, job.language ?? 'dub', true).catch(() => undefined);
    const ok = this.wcoVerdict().ok;
    this.logger.log(ok ? 'wcostream reads again: the queue carries on' : 'wcostream still cannot be read: the queue waits');
    return ok;
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
        const job = this.jobs.find((j) => mayRun(j) && j.episodes.some(ready));
        if (!job) {
          if (this.requeueFailedOnce()) continue;
          this.scheduleWake(); break;
        }
        // wcostream cannot be read (Byparr or FlareSolverr down, a challenge, a new layout): every episode would fail,
        // so the queue waits. One read every ten minutes (the wake-up) says when it reads again (21 Nov 2026).
        if (!this.wcoVerdict().ok && !(await this.probeWco(job))) break;
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
              e.message = brakeMessage(job.refused, until, !!job.auto && !job.now);
            }
            this.logger.warn(`${job.title}: ${job.refused} refusals in a row, waiting ${wait} minutes`);
          }
        } else if (ep.state === 'done') job.refused = 0;
        await this.logAttempt(job, ep);
        if (ep.state === 'failed' && BLOCKED.test(ep.message ?? '')) {
          this.wco?.health?.record('error', ep.message);
          ep.state = 'queued'; ep.message = 'Waiting: wcostream could not be read when it ran; it goes again once wcostream reads';
          ep.notBefore = new Date(Date.now() + 30 * 60 * 1000).toISOString();     // one show blocked must not hold the rest
          await this.save();
          continue;
        }
        if (ep.state === 'failed' && (VIDEO_REFUSED.test(ep.message ?? '') || NO_PLAYER.test(ep.message ?? ''))) {
          await this.markDead(job.slug, ep.id).catch((e) => this.logger.warn(`Could not note ${job.title} ${ep.s}x${ep.e}: ${(e as Error).message}`));
        }
        if (!job.episodes.some((e) => e.state === 'queued')) {
          job.finishedAt = new Date().toISOString();
          if (job.auto && !this.jobs.some((j) => j.auto && j.episodes.some((e) => ['queued', 'downloading', 'importing'].includes(e.state)))) {
            await this.notifyNight().catch((e) => this.logger.warn(`Summary failed: ${(e as Error).message}`));
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
        const map = await this.mapEpisodes(job.seriesId, job.season);
        source = resolveSources(listing, map, !!job.absolute).get(ep.id) ?? source;
        if (source.kind === 'title') {
          // One file can hold several episodes. It is filed under this one and under the others that have no file;
          // an episode that already has a file keeps it.
          const free = new Set(map.filter((e) => e.st === 'missing' || e.st === 'future').map((e) => e.id));
          importIds = source.ids.filter((id) => id === ep.id || free.has(id));
        }
      } catch { /* Sonarr did not answer: the number is used, and the file's title is checked below */ }
    }
    // Someone picked it on the map: wcostream may have posted it since the list was read (kept six hours), so read
    // it again once for this run before refusing (18 Nov 2026).
    if (source.kind === 'none' && source.why === 'unlisted' && !job.auto && this.wco && !this.reread.has(job.id)) {
      this.reread.add(job.id);
      try {
        const again = await this.wco.listing(job.slug, job.language ?? 'dub', true);
        if (again && this.wcoVerdict().ok) source = resolveSources(again, await this.mapEpisodes(job.seriesId, job.season), !!job.absolute).get(ep.id) ?? source;
      } catch { /* refused below */ }
    } else if (source.kind === 'none' && source.why === 'unlisted' && !job.auto && this.wco) {
      const cached = this.wco.peek(job.slug, job.language ?? 'dub');
      if (cached) try { source = resolveSources(cached, await this.mapEpisodes(job.seriesId, job.season), !!job.absolute).get(ep.id) ?? source; } catch { /* refused below */ }
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
  private async handToSonarr(ids: number[], search = true) {
    await this.sonarr('put', 'episode/monitor', { episodeIds: ids, monitored: true });
    if (search) await this.sonarr('post', 'command', { name: 'EpisodeSearch', episodeIds: ids });
  }

  /**
   * One line per finished attempt in config/fill-attempts.jsonl (19 Nov 2026): the queue keeps only its last 50 runs,
   * which left three nights to learn from. Never fails a run.
   */
  private async logAttempt(job: FillJob, ep: FillEpisode) {
    if (!['done', 'premium', 'kept', 'failed'].includes(ep.state)) return;
    const file = path.join(this.configDir, 'fill-attempts.jsonl');
    const line = JSON.stringify({ at: new Date().toISOString(), slug: job.slug, show: job.title, seriesId: job.seriesId, id: ep.id, s: ep.s, e: ep.e,
      auto: !!job.auto, now: !!job.now, mode: ep.mode, state: ep.state,
      kind: ep.state === 'failed' || ep.state === 'kept' ? failureKind(ep.message) : undefined, message: ep.message?.slice(0, 240) }) + '\n';
    try {
      const size = await fs.stat(file).then((st) => st.size, () => 0);
      await fs.mkdir(this.configDir, { recursive: true });
      if (size > ATTEMPT_LOG_MAX) await fs.rename(file, file + '.1');
      await fs.appendFile(file, line);
    } catch (e) { this.logger.warn(`Could not log the attempt: ${(e as Error).message}`); }
  }

  /** The video of this episode could not be had tonight (counted once a night). */
  private async markDead(slug: string, id: number) {
    const day = new Date().toDateString();
    await this.changePrefs((p) => {
      const pref = p[slug]; if (!pref) return;
      const tries = (pref.tries ??= {}), t = tries[id] ?? { n: 0, last: new Date().toISOString() };
      if (t.dead?.day === day) return;
      tries[id] = { ...t, dead: { n: (t.dead?.n ?? 0) + 1, day } };
    });
  }

  /**
   * Read a show's list on wcostream and say whether the link looks like another show (unless someone said it is right)
   * and how many of the episodes it needs wcostream lists. Undefined when the list could not be read properly.
   */
  private async linkVerdict(slug: string, pref: ShowPref, map: MapEpisode[], series: any[]): Promise<{ wrong?: string; onWco: number } | undefined> {
    if (!this.wco) return undefined;
    const listing = await this.wco.listing(slug, pref.language ?? 'dub');
    if (!listing || !this.wcoVerdict().ok) return undefined;
    if (!pref.linkOk) {
      const s = series.find((x) => x.id === pref.seriesId);
      const check = linkCheck(listing, map, !s || matchSeries(slug, [s]).length > 0);
      if (!check.ok) return { wrong: check.why, onWco: 0 };
    }
    const sources = resolveSources(listing, map, !!pref.absolute);
    const work = map.filter((e) => e.st === 'missing' || (e.st === 'undub' && pref.language !== 'sub'));
    return { onWco: work.filter((e) => sources.get(e.id)?.kind !== 'none').length };
  }

  private linkRun?: { done: number; total: number; wrong: number; at: string };
  private linkQueue = Promise.resolve();
  /** How far "Check every link" has got, while it runs. */
  linkProgress() { return this.linkRun && this.linkRun.done < this.linkRun.total ? { ...this.linkRun } : undefined; }

  /**
   * Check links and count what wcostream has (19 Nov 2026), for the given shows (just linked or followed) or every
   * followed show, one after another behind the screen. Nothing is queued; only the link flag and the count change.
   */
  checkLinks(slugs?: string[]): { started: boolean; total: number } {
    if (!this.wco) return { started: false, total: 0 };      // nothing to read the lists with
    const go = async () => {
      const prefs = await this.prefs();
      const list = (slugs ?? Object.keys(prefs).filter((k) => prefs[k].follow)).filter((k) => prefs[k]);
      const got = this.config.sonarrApiKey ? await this.allSeriesNow().catch(() => undefined) : undefined;
      const series: any[] = Array.isArray(got) ? got : [];
      const run = { done: 0, total: list.length, wrong: 0, at: new Date().toISOString() };
      if (!slugs) this.linkRun = run;
      for (const slug of list) {
        try {
          const pref = prefs[slug];
          const map = await this.mapEpisodes(pref.seriesId, pref.season);
          const v = await this.linkVerdict(slug, pref, map, series);
          if (v) {
            if (v.wrong) run.wrong++;
            await this.changePrefs((p) => {
              const now = p[slug]; if (!now || now.seriesId !== pref.seriesId) return;
              if (v.wrong && !now.linkOk) now.linkWrong = { why: v.wrong, at: new Date().toISOString() }; else delete now.linkWrong;
              if (!v.wrong) now.counts = { ...(now.counts ?? countMap(map)), onWco: v.onWco, wcoAt: new Date().toISOString() };
            });
          }
        } catch (e) { this.logger.warn(`Link check for ${slug}: ${(e as Error).message}`); }
        run.done++;
      }
      this.logger.log(`Link check: ${run.done} show(s), ${run.wrong} look linked to another show`);
    };
    if (!slugs && this.linkProgress()) return { started: false, total: this.linkRun!.total };
    this.linkQueue = this.linkQueue.then(go, go);
    return { started: true, total: slugs?.length ?? -1 };
  }

  /**
   * "This wcostream show is Sonarr season N" (21 Nov 2026), or the whole series again (season null). Straight-through
   * numbering comes with a season; the link is checked again at once.
   */
  async setSeason(body: { slug?: string; season?: number | null }) {
    let slug: string;
    try { slug = parseShowLink(String(body?.slug ?? '')).slug; } catch (e) { throw new BadRequestException((e as Error).message); }
    const season = body?.season === null || body?.season === undefined ? undefined : Number(body.season);
    if (season !== undefined && !(Number.isInteger(season) && season > 0)) throw new BadRequestException('A season is a whole number from 1');
    const prefs = await this.changePrefs((p) => {
      const pref = p[slug]; if (!pref) return;
      if (season) { pref.season = season; pref.absolute = true; } else if (pref.season) { delete pref.season; pref.absolute = false; }
      delete pref.unlisted; delete pref.linkWrong;
      if (pref.counts) { delete pref.counts.onWco; delete pref.counts.wcoAt; }    // counted under the old numbering
    });
    if (!prefs[slug]) throw new NotFoundException('That show is not linked');
    this.checkLinks([slug]);
    return { slug, season: prefs[slug].season ?? null, absolute: !!prefs[slug].absolute };
  }

  /** Mark the link of a show right ("The link is right"): the link check leaves it alone from now on. */
  async linkIsRight(body: { slug?: string }) {
    let slug: string;
    try { slug = parseShowLink(String(body?.slug ?? '')).slug; } catch (e) { throw new BadRequestException((e as Error).message); }
    const prefs = await this.changePrefs((p) => { if (p[slug]) { p[slug].linkOk = true; delete p[slug].linkWrong; } });
    if (!prefs[slug]) throw new NotFoundException('That show is not linked');
    return { slug, linkOk: true };
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
    if (body.follow) this.checkLinks([slug]);      // checked at once, not first at night (19 Nov 2026)
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
    if (linked.length) this.checkLinks(linked);
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
        unlisted: p.unlisted?.ids.length ?? 0, switchTo: switchTo(p),
        onWco: p.counts?.onWco, linkWrong: p.linkOk ? undefined : p.linkWrong?.why };
    });
  }

  /** Five past the hour the night window opens (01:05 by default): make the night's plan. */
  @Cron('5 * * * *')
  async nightlyTick() { if (new Date().getHours() === NIGHT.from) await this.nightlyPlan(); }

  private planning?: Promise<FillJob[]>;
  /**
   * Queue what is due for each followed show. The runs start inside the night window, or straight away with `now`
   * ("Fill now", 18 Nov 2026). One plan at a time: a second call joins the one running and gets its runs.
   */
  nightlyPlan(opts: { now?: boolean } = {}): Promise<FillJob[]> {
    return (this.planning ??= this.plan(!!opts.now).finally(() => { this.planning = undefined; }));
  }

  private async plan(now = false): Promise<FillJob[]> {
    const made: FillJob[] = [];
    const prefs = await this.prefs();
    const busy = this.activeIds();
    let budget = SETTINGS.nightBudget;
    // Every followed show is looked at (and counted) first; then the shows with the fewest episodes due are queued
    // first, so new weekly episodes and nearly complete shows are not stuck behind a 200-episode backlog.
    const plans: { slug: string; pref: ShowPref; due: number[] }[] = [];
    const deadline = Date.now() + 30 * 60 * 1000;      // reading wcostream's lists must not eat the night
    const handOff: HandOff[] = [];
    const got = this.config.sonarrApiKey ? await this.allSeriesNow().catch(() => undefined) : undefined;
    const series: any[] = Array.isArray(got) ? got : [];     // without the list, the names are not compared
    const recentDay = new Date(Date.now() - NEW_DUB_DAYS * 86400000).toISOString().slice(0, 10);
    for (const [slug, pref] of Object.entries(prefs).filter(([, p]) => p.follow)) {
      try {
        const map = await this.mapEpisodes(pref.seriesId, pref.season);
        const last = pref.counts;
        pref.counts = countMap(map);
        const tries = (pref.tries ??= {});
        const due: number[] = [], gaveUp: MapEpisode[] = [], dead: MapEpisode[] = [];
        for (const e of map) {
          const work = e.st === 'missing' || (e.st === 'undub' && pref.language !== 'sub');
          if (!work) { delete tries[e.id]; continue; }
          if (busy.has(e.id)) continue;
          const t = tries[e.id];
          // The video could not be had on two nights (refused, or no player): Sonarr, not four tries (18 Nov 2026).
          if ((t?.dead?.n ?? 0) >= 2 && e.st === 'missing') { if (!t!.handedToSonarr) dead.push(e); continue; }
          const verdict = retryDue(e.a, t);
          if (verdict === 'due') due.push(e.id);
          else if (verdict === 'give-up' && !t?.handedToSonarr && e.st === 'missing') gaveUp.push(e);
        }
        if (gaveUp.length) handOff.push({ slug, pref, eps: gaveUp, why: `tried ${RETRY_DAYS.length} times` });
        if (dead.length) handOff.push({ slug, pref, eps: dead, why: 'its video could not be had on two nights' });
        if (!due.length) { delete pref.unlisted; if (last?.onWco !== undefined) Object.assign(pref.counts, { onWco: last.onWco, wcoAt: last.wcoAt }); continue; }
        // None of this show's gaps was on wcostream at the last read: read again after a few days, or when one airs.
        const quiet = last?.onWco === 0 && last.wcoAt && Date.now() - new Date(last.wcoAt).getTime() < NONE_ON_WCO_DAYS * 86400000 &&
          !map.some((e) => due.includes(e.id) && e.a && e.a >= recentDay);
        if (quiet) { Object.assign(pref.counts, { onWco: 0, wcoAt: last!.wcoAt }); continue; }
        // Is the link this show at all? Another show's list would plan episodes that can never match (18 Nov 2026).
        if (Date.now() < deadline) {
          const v = await this.linkVerdict(slug, pref, map, series);
          if (v?.wrong) {
            if (!pref.linkWrong) this.nightNotes.push(`${pref.title ?? slug}: the link to ${slug} on wcostream looks like another show (${v.wrong}); left out until it is changed`);
            pref.linkWrong = { why: v.wrong, at: new Date().toISOString() };
            continue;
          }
          if (v) { delete pref.linkWrong; Object.assign(pref.counts, { onWco: v.onWco, wcoAt: new Date().toISOString() }); }
        }
        const kept = await this.dropUnlisted(slug, pref, map, due, tries, deadline, handOff);
        if (kept.length) plans.push({ slug, pref, due: kept });
      } catch (err) {
        this.logger.warn(`Nightly plan for ${slug}: ${(err as Error).message}`);
      }
    }
    // Only when wcostream read properly all through the plan: a page that broke halfway must not hand a library over.
    // Handed to Sonarr: every one monitored; searched for only up to HAND_SEARCH_PER_NIGHT a night, newest first.
    // The unlisted ones only while wcostream reads properly (a broken site must not empty the list into Sonarr).
    const ready = handOff.filter((h) => !h.unlisted || this.wcoVerdict().ok);
    const searchFor = newestIds(ready.map((h) => h.eps), HAND_SEARCH_PER_NIGHT);
    let searches = 0, unsearched = 0;
    for (const { slug, pref, eps, why } of ready) {
      const find = eps.filter((e) => searchFor.has(e.id));
      const rest = eps.filter((e) => !find.includes(e));
      try {
        if (find.length) await this.handToSonarr(find.map((e) => e.id));
        if (rest.length) await this.handToSonarr(rest.map((e) => e.id), false);
        searches += find.length; unsearched += rest.length;
        for (const e of eps) pref.tries![e.id] = { ...pref.tries![e.id], n: pref.tries![e.id]?.n ?? 0, last: pref.tries![e.id]?.last ?? new Date().toISOString(), handedToSonarr: true };
        const codes = eps.map((e) => `${e.s}x${pad(e.e)}`);
        this.nightNotes.push(`${pref.title ?? slug} ${codes.length <= 4 ? codes.join(', ') : `${codes.length} episodes, ${codes[0]} to ${codes[codes.length - 1]}`}: ` +
          `${why}, handed to Sonarr${rest.length ? ` (${find.length ? `${find.length} searched for, ` : ''}${rest.length} monitored for Sonarr to find)` : ''}`);
      } catch (err) {
        this.logger.warn(`Handing ${slug} to Sonarr: ${(err as Error).message}`);
      }
    }
    if (unsearched) this.logger.log(`Handed to Sonarr: ${searches} searched for, ${unsearched} monitored only (at most ${HAND_SEARCH_PER_NIGHT} searches a night)`);
    plans.sort((a, b) => a.due.length - b.due.length || (a.pref.lastPlanned ?? '').localeCompare(b.pref.lastPlanned ?? ''));
    for (const { slug, pref, due } of plans) {
      if (budget <= 0) break;
      try {
        const tries = (pref.tries ??= {});
        const job = await this.createJob({ seriesId: pref.seriesId, slug, language: pref.language ?? 'dub',
          absolute: pref.absolute, episodeIds: due.slice(0, Math.min(40, budget)), auto: true, now });
        made.push(job);
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
        if (mine.tries) {
          for (const [id, t] of Object.entries(now.tries ?? {})) if (t.dead && mine.tries[id] && (mine.tries[id].dead?.n ?? 0) < t.dead.n) mine.tries[id].dead = t.dead;
          now.tries = mine.tries;
        }
        if (mine.linkWrong && !now.linkOk) now.linkWrong = mine.linkWrong; else delete now.linkWrong;
        if (mine.lastPlanned) now.lastPlanned = mine.lastPlanned;
        if (mine.unlisted) now.unlisted = mine.unlisted; else delete now.unlisted;
      }
    });
    void this.pump();
    return made;
  }

  /**
   * Take out of tonight's list the episodes wcostream does not list for this show (12 Nov 2026: 33 of the first night's
   * 47 failures were "list index out of range", an episode the site does not have under that number). They count as a
   * try, so after the usual four the episode is handed to Sonarr to search for. Unknown (a failed read, or wcostream
   * unreadable) never drops anything. An episode that aired over UNLISTED_HAND_DAYS ago and was not listed at the check
   * before either is unlikely to appear: it goes on the hand-off list for Sonarr now (18 Nov 2026), not after four tries.
   */
  private async dropUnlisted(slug: string, pref: ShowPref, map: MapEpisode[], due: number[], tries: NonNullable<ShowPref['tries']>,
    deadline: number, handOff: HandOff[] = []): Promise<number[]> {
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
    if (hand.length) handOff.push({ slug, pref, eps: hand, why: `not on wcostream at two checks running, aired over ${UNLISTED_HAND_DAYS} days ago`, unlisted: true });
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
              const map = await this.mapEpisodes(pref.seriesId, pref.season);
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
  /**
   * `fresh` reads the show page again rather than use the copy kept for six hours. `pickLink`, an episode's own link,
   * asks which of the show's episodes in Sonarr it is: `picked` lists them (two when the link holds two), or is empty
   * when that episode cannot be told apart, for example a number whose title says it is a different episode.
   */
  async wcoCheck(link: string, seriesIdParam?: string, langParam?: string, absoluteParam?: string, freshParam?: string, pickLink?: string) {
    let parsed;
    try { parsed = parseShowLink(link); } catch (e) { throw new BadRequestException((e as Error).message); }
    const none = { checked: false, unlisted: [] as number[], latest: '' };
    if (!this.wco) return none;
    const prefs = await this.prefs();
    const seriesId = seriesIdParam ? Number(seriesIdParam) : prefs[parsed.slug]?.seriesId;
    if (!seriesId) return none;
    const language = langParam === 'sub' || langParam === 'dub' ? langParam : prefs[parsed.slug]?.language ?? 'dub';
    const season = prefs[parsed.slug]?.seriesId === seriesId ? prefs[parsed.slug]?.season : undefined;
    const absolute = season ? true : absoluteParam !== undefined ? absoluteParam === 'true' : !!prefs[parsed.slug]?.absolute;
    const listing = await this.wco.listing(parsed.slug, language, freshParam === '1' || freshParam === 'true');
    if (!listing || !this.wcoVerdict().ok) return none;
    const map = await this.mapEpisodes(seriesId, season);
    const sources = resolveSources(listing, map, absolute);
    const picked = pickLink ? pickedBy(pickLink, map, sources, absolute) : undefined;
    const work = map.filter((e) => e.st === 'missing' || e.st === 'undub' || e.st === 'unknown');
    const gone = work.filter((e) => sources.get(e.id)?.kind === 'none');
    // Episodes the site has inside a link that holds several: the map says which go together.
    const together: Record<number, number[]> = {};
    for (const e of map) { const s = sources.get(e.id); if (s?.kind === 'title' && s.ids.length > 1) together[e.id] = s.ids; }
    const other = { ...numberingFit(listing, map, new Set(work.filter((e) => e.st !== 'unknown').map((e) => e.id)), absolute) };
    return { checked: true, unlisted: gone.map((e) => e.id), different: gone.filter((e) => (sources.get(e.id) as any).why === 'different').length,
      byTitle: work.filter((e) => sources.get(e.id)?.kind === 'title').length, together, fit: other,
      latest: latestText(listing), language, listed: listing.count, readAt: this.wco.readAt(parsed.slug, language), ...(picked ? { picked } : {}) };
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

  /** Two minutes past the hour the night window closes: tell what the night did, even with episodes parked past it. */
  @Cron('2 * * * *')
  async nightClosing() {
    if (new Date().getHours() !== NIGHT.to) return;
    await this.notifyNight().catch((e) => this.logger.warn(`Summary failed: ${(e as Error).message}`));
  }

  /** Every 10 minutes: start any automatic runs that are waiting for the night window. */
  @Cron('*/10 * * * *')
  wake() { if (isNight() || !this.wcoVerdict().ok) void this.pump(); }

  private nightNotes: string[] = [];
  /** Runs whose list was read again for an episode it did not list, so it is read once per run. */
  private reread = new Set<string>();

  private get lastRunFile() { return path.join(this.configDir, 'last-run.json'); }
  private lastRun?: LastRun | null;     // undefined: not read from disk yet

  /** The summary of the last automatic runs, or null before the first. */
  async getLastRun(): Promise<LastRun | null> {
    if (this.lastRun === undefined) {
      try { this.lastRun = JSON.parse(await fs.readFile(this.lastRunFile, 'utf8')) as LastRun; } catch { this.lastRun = null; }
    }
    return this.lastRun ?? null;
  }

  /**
   * Once the automatic runs have finished: keep their summary for the home screen and, for an overnight one, send it
   * to NOTIFY_URL (when set). It covers the runs made since the last summary (at most the last 20 hours), so a
   * "Fill now" in the afternoon does not count last night again; with no new runs nothing is written or sent.
   */
  private async notifyNight() {
    const { publicUrl } = this.config;
    // Every finished episode is told once (19 Nov 2026): the night's runs were never all finished while some were
    // parked past 07:00, so no summary was written. Runs made in the last day, or partly told already, are looked at.
    const FINAL = ['done', 'premium', 'kept', 'failed'];
    const recent = Date.now() - 24 * 3600 * 1000;
    const untold = (j: FillJob, id: number) => !(j.told ?? []).includes(id);
    const runs = this.jobs.filter((j) => j.auto && (new Date(j.createdAt).getTime() > recent || j.told?.length) &&
      j.episodes.some((e) => FINAL.includes(e.state) && untold(j, e.id)));
    if (!runs.length) return;
    const { tally: t, shows, reasons, waiting } = tallyRuns(runs, (j, id) => !untold(j, id));
    for (const j of runs) j.told = [...new Set([...(j.told ?? []), ...j.episodes.filter((e) => FINAL.includes(e.state)).map((e) => e.id)])];
    await this.save();
    const notes = this.nightNotes.splice(0);
    const attention = await this.attention().then((a) => a.length, () => 0);
    const kind: LastRun['kind'] = runs.every((j) => j.now) ? 'now' : 'night';
    const from = runs.map((j) => j.createdAt).sort()[0];
    this.lastRun = { at: new Date().toISOString(), from, kind, tally: t, shows, notes: notes.slice(0, 30), attention, reasons, waiting };
    try {
      await fs.mkdir(this.configDir, { recursive: true });
      const tmp = this.lastRunFile + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(this.lastRun, null, 2));
      await fs.rename(tmp, this.lastRunFile);
    } catch (e) { this.logger.warn(`Could not keep the run summary: ${(e as Error).message}`); }
    const filledShows = shows.filter((r) => r.filled + r.swapped > 0).map((r) => r.title);
    const body = `${kind === 'now' ? 'Filled now' : 'Overnight'}: ${t.filled} filled, ${t.swapped} swapped to dub, ${t.premium} premium to Sonarr, ${t.kept} to check, ${t.failed} failed.` +
      (filledShows.length ? `\nShows: ${filledShows.slice(0, 8).join(', ')}.` : '') +
      (Object.keys(reasons).length ? `\nWhy: ${Object.entries(reasons).sort((a, b) => b[1]! - a[1]!).map(([k, n]) => `${n} ${KIND_WORDS[k as FailureKind]}`).join(', ')}.` : '') +
      (waiting ? `\n${waiting} wait for the next night (parked after refusals).` : '') +
      (notes.length ? '\n' + notes.slice(0, 5).join('\n') : '') +
      (attention ? `\n${attention} need you: open the link.` : '');
    this.logger.log(body.replace(/\n/g, ' | '));
    if (kind === 'now') return;           // someone pressed the button, and the home screen shows the summary
    const disk = await this.checkDisk();
    const wco = this.wcoVerdict();
    if (!wco.ok) { this.wcoToldAt = Date.now(); this.wcoTold = true; this.wcoPending = false; }
    const stage = await this.staging().catch(() => undefined);
    const text = body + (disk.low ? `\n${lowDiskMessage(disk)}.` : '') + (wco.ok ? '' : `\nwcostream cannot be read: ${wco.why}. ${WCO_HELD}`) +
      (stage?.old.files ? `\n${stage.old.folders} downloads in staging untouched for ${STAGE_OLD_DAYS} days (${gb(stage.old.bytes)}): delete them on Needs you.` : '');
    await this.push('wco-dl overnight', text, publicUrl ? `${publicUrl}/map.html#night` : undefined);
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
        const map = await this.mapEpisodes(seriesId, pref.season);
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
        dirs.push(dir);                       // an empty folder goes with the old ones, but is no download to mention
        if (st.files) { old.folders++; old.files += st.files; old.bytes += st.bytes; }
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
      try { await fs.rm(dir, { recursive: true, force: true }); if (st.files) folders++; bytes += st.bytes; } catch { /* in use: left */ }
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
export const NOT_LISTED = /No episode matches|No episodes found(?! on \S+ \(HTTP [45]\d\d\))|list index out of range|does not list this episode|is another episode/i;
/**
 * wcostream could not be read at all (21 Nov 2026: FlareSolverr had stopped, so every show page came back as a 403
 * block page, "No episodes found on x (HTTP 403)", and 274 episodes failed as "not listed" in two runs). Not the
 * episode's fault: it goes back in the queue and the queue waits until wcostream reads again.
 */
export const BLOCKED = /No episodes found on \S+ \(HTTP [45]\d\d\)|Byparr request to \S+ for \S+ failed|ECONNREFUSED \S+:8191/i;

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
