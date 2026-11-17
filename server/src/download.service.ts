import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import axios from 'axios';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { promisify } from 'util';
import { APP_CONFIG } from './app-config.provider';
import { AppConfig } from './config';
import { assertSpace, diskState, lowDiskMessage } from './disk-space';
import { WCO_BASE_URL } from './content-list';
import { BatchDownload, CreateShow } from './dto/all.dto';
import { ProcessResult, startProcess } from './process-runner';
import {
  WebhookTargetError,
  assertPublicWebhookUrl,
  guardedHttpAgent,
  guardedHttpsAgent,
} from './webhook-target';

const execFileAsync = promisify(execFile);

export type DownloadKind = 'show' | 'episode';
/** queued: waiting for one of the running downloads to finish (at most MAX_PARALLEL_DOWNLOADS run at once). */
export type DownloadStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timed_out';

export interface StepResult {
  status: 'ok' | 'skipped' | 'failed';
  message?: string;
}

export interface PostProcessResult {
  folder: string;
  permissions: StepResult;
  sonarr: StepResult;
}

export interface DownloadJob {
  id: string;
  kind: DownloadKind;
  name: string;
  url: string;
  language?: string;
  quality?: string;
  outputFolder: string;
  status: DownloadStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  postProcess?: PostProcessResult;
  /** Last lines of the Python output, for display in the UI. */
  log: string[];
}

const MAX_LOG_LINES = 30;
const MAX_LOG_LINE_LENGTH = 500;
const MAX_TRACKED_JOBS = 100;
const MAX_BATCH_SIZE = 50;
const MAX_WEBHOOKS = 20;
const WEBHOOK_TIMEOUT_MS = 10000;

const SLUG_RE = /^[\w%-]{1,300}$/;
const SEASON_RE = /^\d+$/;
const EPISODE_RANGE_RE = /^\d+(-\d+)?$/;
const LANGUAGE_RE = /^(dub|sub)$/;
const QUALITY_RE = /^(480|720|1080)$/;
const WCO_URL_PREFIX_RE = /^https?:\/\/(www\.)?wcostream\.tv\//i;

interface PreparedShowDownload {
  slug: string;
  url: string;
  outputFolder: string;
  args: string[];
  options: JobOptions;
}

type JobOptions = Pick<DownloadJob, 'language' | 'quality'>;

/**
 * Accepts a bare slug, a `/anime/<slug>` path or a full wcostream URL and
 * returns the slug. Rejects anything that could escape the output folder.
 */
export function normalizeSlug(
  input: unknown,
  stripAnimePrefix: boolean,
): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new BadRequestException('Missing parameter: name');
  }

  let slug = input
    .trim()
    .replace(WCO_URL_PREFIX_RE, '')
    .split(/[?#]/)[0]
    .replace(/^\/+|\/+$/g, '');
  if (stripAnimePrefix) {
    slug = slug.replace(/^anime\//, '');
  }

  if (!SLUG_RE.test(slug)) {
    throw new BadRequestException(`Invalid name: ${input}`);
  }
  return slug;
}

function optionalParam(
  value: unknown,
  pattern: RegExp,
  label: string,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (!pattern.test(text)) {
    throw new BadRequestException(`Invalid ${label}: ${text}`);
  }
  return text;
}

export function validateWebhookUrl(input: unknown): string {
  const text = typeof input === 'string' ? input.trim() : '';
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new BadRequestException(`Invalid webhook URL: ${text}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException(`Webhook URL must be http(s): ${text}`);
  }
  return text;
}

@Injectable()
export class DownloadService {
  private readonly logger = new Logger(DownloadService.name);
  private readonly jobs = new Map<string, DownloadJob>();
  private readonly webhooks = new Set<string>();
  /** Jobs waiting for a free place, oldest first, with the arguments to start them with. */
  private readonly waiting: { job: DownloadJob; fullArgs: string[] }[] = [];
  private active = 0;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    for (const url of config.webhookUrls ?? []) {
      try {
        this.webhooks.add(validateWebhookUrl(url));
      } catch (error) {
        this.logger.warn(`Ignoring WEBHOOK_URLS entry: ${error.message}`);
      }
    }
  }

  showFolder(slug: string): string {
    return `${this.config.outputBase}/${slug}/`;
  }

  async startShowDownload(body: CreateShow): Promise<DownloadJob> {
    const { slug, url, outputFolder, args, options } =
      this.prepareShowDownload(body);
    return this.startJob('show', slug, url, outputFolder, args, options);
  }

  /** Validates every name before starting anything, so a typo can't leave half a batch running. */
  async startBatchDownload(body: BatchDownload): Promise<DownloadJob[]> {
    const names = body?.names;
    if (!Array.isArray(names) || names.length === 0) {
      throw new BadRequestException('names must be a non-empty array');
    }
    if (names.length > MAX_BATCH_SIZE) {
      throw new BadRequestException(
        `A batch can contain at most ${MAX_BATCH_SIZE} names`,
      );
    }

    const prepared = new Map<string, PreparedShowDownload>();
    for (const name of names) {
      const download = this.prepareShowDownload({
        ...body,
        name,
      } as CreateShow);
      if (!prepared.has(download.slug)) prepared.set(download.slug, download);
    }

    const jobs: DownloadJob[] = [];
    for (const {
      slug,
      url,
      outputFolder,
      args,
      options,
    } of prepared.values()) {
      jobs.push(
        await this.startJob('show', slug, url, outputFolder, args, options),
      );
    }
    return jobs;
  }

  private prepareShowDownload(body: CreateShow): PreparedShowDownload {
    const slug = normalizeSlug(body?.name, true);
    const season = optionalParam(body.season, SEASON_RE, 'season');
    const episode = optionalParam(
      body.episode,
      EPISODE_RANGE_RE,
      'episode range',
    );
    const language = optionalParam(body.language, LANGUAGE_RE, 'language');
    const quality = optionalParam(body.quality, QUALITY_RE, 'quality') ?? '1080';
    const newest = body.newest === true || String(body.newest) === 'true';

    const url = `${WCO_BASE_URL}/anime/${slug}${language ? `?lang=${language}` : ''}`;
    const outputFolder = this.showFolder(slug);
    const args = ['-i', url];
    if (season) args.push('-se', season);
    if (episode) args.push('-epr', episode);
    // __main__.py only distinguishes SD from HD via -hd.
    if (quality !== '480') args.push('-hd');
    if (newest) args.push('-n');
    args.push('-o', outputFolder, '-t', '2');

    return { slug, url, outputFolder, args, options: { language, quality } };
  }

  async startEpisodeDownload(name: unknown): Promise<DownloadJob> {
    const slug = normalizeSlug(name, false);
    // Episodes of the same show share a folder: `<show>-episode-2-...` -> `<show>`.
    const title = slug.split('-episode-')[0];

    const url = `${WCO_BASE_URL}/${slug}`;
    const outputFolder = this.showFolder(title);
    const args = ['-i', url, '-o', outputFolder, '-t', '2'];

    return this.startJob('episode', slug, url, outputFolder, args);
  }

  listJobs(): DownloadJob[] {
    return [...this.jobs.values()].reverse();
  }

  getJob(id: string): DownloadJob | undefined {
    return this.jobs.get(id);
  }

  async addWebhook(url: unknown): Promise<string[]> {
    const valid = validateWebhookUrl(url);
    await this.assertAllowedWebhookTarget(valid);
    if (this.webhooks.has(valid)) {
      throw new ConflictException(`Webhook ${valid} is already registered`);
    }
    if (this.webhooks.size >= MAX_WEBHOOKS) {
      throw new BadRequestException(
        `At most ${MAX_WEBHOOKS} webhooks can be registered`,
      );
    }
    this.webhooks.add(valid);
    return this.listWebhooks();
  }

  removeWebhook(url: string): boolean {
    return this.webhooks.delete(url);
  }

  listWebhooks(): string[] {
    return [...this.webhooks];
  }

  private async assertAllowedWebhookTarget(url: string): Promise<void> {
    if (this.config.webhookAllowInternal) return;
    try {
      await assertPublicWebhookUrl(url);
    } catch (error) {
      if (error instanceof WebhookTargetError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  private async startJob(
    kind: DownloadKind,
    name: string,
    url: string,
    outputFolder: string,
    args: string[],
    options: JobOptions = {},
  ): Promise<DownloadJob> {
    await assertSpace(this.config.outputBase, this.config.minFreeGb ?? 0);
    const fullArgs = [this.config.pythonScript, ...args];
    const job: DownloadJob = {
      id: randomUUID(),
      kind,
      name,
      url,
      ...options,
      outputFolder,
      status: 'queued',
      startedAt: new Date().toISOString(),
      log: [],
    };

    if (this.active >= Math.max(1, this.config.maxParallelDownloads ?? 3)) {
      this.logger.log(`Queued: ${name} (${this.active} downloads running)`);
      this.waiting.push({ job, fullArgs });
      this.trackJob(job);
      return job;
    }
    await this.launch(job, fullArgs);
    return job;
  }

  /** Start the oldest waiting job while there is room. One that cannot start fails on its own, not the others. */
  private startWaiting() {
    while (this.waiting.length && this.active < Math.max(1, this.config.maxParallelDownloads ?? 3)) {
      const { job, fullArgs } = this.waiting.shift()!;
      this.launch(job, fullArgs).catch((error) => {
        job.status = 'failed';
        job.error = error.message;
        job.finishedAt = new Date().toISOString();
        void this.notifyWebhooks(job);
        this.startWaiting();     // its place is free again: the next one gets its turn
      });
    }
  }

  private async launch(job: DownloadJob, fullArgs: string[]): Promise<void> {
    const { pythonBin, downloadIdleTimeoutMs } = this.config;
    // The place is taken before the first await, or startWaiting's loop would start every waiting job at once.
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.active++;
    // A waiting download is checked again when its turn comes: the drive may have filled meanwhile.
    const disk = await diskState(this.config.outputBase, this.config.minFreeGb ?? 0);
    if (disk.low) {
      this.active--;
      throw new Error('Not started: ' + lowDiskMessage(disk));
    }
    this.logger.log(`Starting: ${pythonBin} ${fullArgs.join(' ')}`);

    let running;
    try {
      running = await startProcess({
        command: pythonBin,
        args: fullArgs,
        idleTimeoutMs: downloadIdleTimeoutMs,
        // Without this Python block-buffers piped stdout, which starves the
        // idle timeout of output and gets healthy downloads killed.
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        onOutput: (chunk, stream) => {
          (stream === 'stderr' ? process.stderr : process.stdout).write(chunk);
          this.appendLog(job, chunk);
        },
      });
    } catch (error) {
      this.active--;
      this.logger.error(`Could not start ${pythonBin}: ${error.message}`);
      throw new InternalServerErrorException(
        `Could not start the downloader (${pythonBin}): ${error.message}`,
      );
    }

    this.trackJob(job);
    running.result.then((result) => {
      // The place is freed as soon as the downloader stops; importing into Sonarr afterwards does not hold it.
      this.active--;
      this.startWaiting();
      return this.finishJob(job, result);
    });
  }

  private async finishJob(job: DownloadJob, result: ProcessResult) {
    job.status = result.outcome;
    job.exitCode = result.exitCode;
    job.signal = result.signal;
    job.error = result.error;
    job.finishedAt = new Date().toISOString();

    const summary = `Download ${job.name} ${job.status}`;
    if (job.status === 'completed') {
      this.logger.log(summary);
    } else {
      this.logger.warn(`${summary}: ${job.error}`);
    }

    // Episodes finished before a failure or timeout are still worth importing.
    try {
      job.postProcess = await this.postProcess(job.outputFolder);
    } catch (error) {
      this.logger.error(`Post-processing ${job.name} failed: ${error.message}`);
    }

    await this.notifyWebhooks(job);
  }

  private async notifyWebhooks(job: DownloadJob) {
    const payload = {
      id: job.id,
      name: job.name,
      status: job.status,
      url: job.url,
      outputFolder: job.outputFolder,
      error: job.error,
    };
    const guarded = !this.config.webhookAllowInternal;
    await Promise.all(
      this.listWebhooks().map(async (webhook) => {
        try {
          // Re-checked on every delivery: WEBHOOK_URLS entries are never
          // checked at startup, and DNS answers can change after registration.
          await this.assertAllowedWebhookTarget(webhook);
          await axios.post(webhook, payload, {
            timeout: WEBHOOK_TIMEOUT_MS,
            // A redirect could point the request at an internal address.
            maxRedirects: 0,
            ...(guarded && {
              httpAgent: guardedHttpAgent,
              httpsAgent: guardedHttpsAgent,
            }),
          });
        } catch (error) {
          const message =
            axios.isAxiosError(error) && error.response
              ? `HTTP ${error.response.status}`
              : error.message;
          this.logger.error(`Webhook ${webhook} failed: ${message}`);
        }
      }),
    );
  }

  /** Fixes file ownership and asks Sonarr to import the folder. */
  async postProcess(folder: string): Promise<PostProcessResult> {
    const permissions = await this.applyPermissions(folder);
    const sonarr = await this.triggerSonarrImport(folder);
    return { folder, permissions, sonarr };
  }

  private async applyPermissions(folder: string): Promise<StepResult> {
    const { isProd, puid, pgid } = this.config;
    if (!isProd) {
      return { status: 'skipped', message: 'Only runs in production' };
    }
    if (!puid || !pgid) {
      return { status: 'skipped', message: 'PUID/PGID not set' };
    }

    const script = path.resolve(__dirname, 'change-permissions.sh');
    try {
      const { stdout } = await execFileAsync(
        'bash',
        [script, folder, '775', puid, pgid],
        { timeout: 5 * 60 * 1000 },
      );
      this.logger.log(stdout.trim());
      return { status: 'ok' };
    } catch (error) {
      const message = (error.stderr || error.message || '').toString().trim();
      this.logger.error(`Setting permissions on ${folder} failed: ${message}`);
      return { status: 'failed', message };
    }
  }

  /** The folder as Sonarr sees it: OUTPUT_BASE swapped for SONARR_IMPORT_BASE when Sonarr runs elsewhere. */
  private sonarrPath(folder: string, outputBase: string, importBase?: string): string {
    if (!importBase || !folder.startsWith(outputBase)) return folder;
    const rest = folder.slice(outputBase.length);
    const sep = importBase.includes('\\') ? '\\' : '/';
    return importBase.replace(/[\\/]+$/, '') + sep + rest.split(/[\\/]/).filter(Boolean).join(sep);
  }

  private async triggerSonarrImport(folder: string): Promise<StepResult> {
    const { isProd, sonarrUrl, sonarrApiKey, sonarrImportBase, outputBase } = this.config;
    if (!isProd) {
      return { status: 'skipped', message: 'Only runs in production' };
    }
    if (!sonarrApiKey) {
      return { status: 'skipped', message: 'SONARR_API_KEY not set' };
    }

    try {
      const { data } = await axios.post(
        `${sonarrUrl}/api/v3/command`,
        { name: 'DownloadedEpisodesScan', path: this.sonarrPath(folder, outputBase, sonarrImportBase) },
        {
          headers: { 'X-Api-Key': sonarrApiKey },
          timeout: 15000,
        },
      );
      this.logger.log(`Sonarr import initiated: ${data?.status}`);
      return { status: 'ok', message: data?.status };
    } catch (error) {
      const message =
        axios.isAxiosError(error) && error.response
          ? `HTTP ${error.response.status} from ${sonarrUrl}`
          : `${sonarrUrl}: ${error.message}`;
      this.logger.error(`Sonarr import failed: ${message}`);
      return { status: 'failed', message };
    }
  }

  private appendLog(job: DownloadJob, chunk: string) {
    for (const line of chunk.split(/\r\n|\r|\n/)) {
      const trimmed = line.trim();
      if (trimmed) job.log.push(trimmed.slice(0, MAX_LOG_LINE_LENGTH));
    }
    if (job.log.length > MAX_LOG_LINES) {
      job.log.splice(0, job.log.length - MAX_LOG_LINES);
    }
  }

  private trackJob(job: DownloadJob) {
    this.jobs.set(job.id, job);
    if (this.jobs.size <= MAX_TRACKED_JOBS) return;
    for (const [id, existing] of this.jobs) {
      if (existing.status !== 'running' && existing.status !== 'queued') {
        this.jobs.delete(id);
        if (this.jobs.size <= MAX_TRACKED_JOBS) return;
      }
    }
  }
}
