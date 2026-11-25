import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SetupGuard } from './setup.controller';
import { AppService } from './app.service';
import { ContentItem } from './content-list';
import {
  DownloadJob,
  DownloadService,
  PostProcessResult,
  normalizeSlug,
} from './download.service';
import {
  BatchDownload,
  CreateShow,
  ProcessShow,
  SingleEpisodeReq,
  WebhookReq,
} from './dto/all.dto';
import { JsonRequestGuard } from './json-request.guard';
import { FillJob, FillService } from './fill.service';
import { DubCalendarService } from './dub-calendar.service';
import { CatalogueItem, searchCatalogue } from './fill.util';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly downloadService: DownloadService,
    private readonly fillService: FillService,
    private readonly dubCalendar: DubCalendarService,
  ) {}

  // ---- Episode map (11 Nov 2026): look a show up from its wco link, then fill ticked episodes ----
  @Get('show')
  lookupShow(@Query('url') url: string, @Query('seriesId') seriesId?: string, @Query('absolute') absolute?: string) {
    return this.fillService.lookup(url, seriesId, absolute);
  }

  // Numbering check (13 Nov 2026): would the site list more of a show's episodes under the other way of numbering?
  @Get('numbering')
  numbering() {
    return this.fillService.numbering();
  }

  @Post('numbering/scan')
  @UseGuards(JsonRequestGuard)
  numberingScan() {
    return this.fillService.startNumberingScan();
  }

  // Which of a show's episodes wcostream does not list (12 Nov 2026).
  @Get('show/wco')
  // fresh=1 reads the show page again; pick=<episode link> says which episodes that link is (18 Nov 2026).
  showWco(@Query('url') url: string, @Query('seriesId') seriesId?: string, @Query('lang') lang?: string, @Query('absolute') absolute?: string,
    @Query('fresh') fresh?: string, @Query('pick') pick?: string) {
    return this.fillService.wcoCheck(url, seriesId, lang, absolute, fresh, pick);
  }

  // A show's small poster, for the lists. Fetched from Sonarr by the server and kept by the browser for a day.
  @Get('poster/:seriesId')
  @Header('Cache-Control', 'private, max-age=86400')
  async poster(@Param('seriesId') seriesId: string): Promise<StreamableFile> {
    const { data, type } = await this.fillService.poster(Number(seriesId));
    return new StreamableFile(data, { type, length: data.length });
  }

  @Get('series-search')
  searchSeries(@Query('q') q: string) {
    return this.fillService.searchSeries(q);
  }

  @Post('fill')
  @UseGuards(JsonRequestGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  fill(@Body() body: any): Promise<FillJob> {
    return this.fillService.createJob(body);
  }

  @Get('fill/jobs')
  fillJobs(): FillJob[] {
    return this.fillService.listJobs();
  }

  @Get('fill/jobs/:id')
  fillJob(@Param('id') id: string): FillJob {
    return this.fillService.getJob(id);
  }

  @Post('fill/jobs/:id/cancel')
  @UseGuards(JsonRequestGuard)
  cancelFill(@Param('id') id: string): Promise<FillJob> {
    return this.fillService.cancel(id);
  }

  @Get('fill/jobs/:id/log/:episodeId')
  fillLog(@Param('id') id: string, @Param('episodeId') episodeId: string): Promise<string> {
    return this.fillService.episodeLog(id, Number(episodeId));
  }

  @Get('followed')
  async followed(@Res({ passthrough: true }) res: Response) {
    const list = await this.fillService.followed();
    // Answered from the last known Sonarr facts while they are refreshed behind: the screen asks again shortly.
    if (this.fillService.followedRefreshing) res.setHeader('X-Followed-Refreshing', '1');
    return list;
  }

  @Post('follow')
  @UseGuards(JsonRequestGuard)
  follow(@Body() body: any) {
    return this.fillService.setFollow(body);
  }

  // ---- Library gaps (11 Nov 2026): every animated series with gaps, matched to wcostream's catalogue ----
  private async catalogue(): Promise<{ items: CatalogueItem[]; errors: string[] }> {
    const lists = ['dubbed', 'cartoon', 'subbed'] as const;
    const got = await Promise.allSettled(lists.map((l) => this.appService.getContentList(l)));
    const items: CatalogueItem[] = [];
    const errors: string[] = [];
    got.forEach((r, i) => {
      if (r.status === 'fulfilled') items.push(...r.value.filter((x) => x.kind === 'series').map((x) => ({ name: x.name, path: x.path, list: lists[i] })));
      else errors.push(`${lists[i]} list: ${(r.reason as Error)?.message ?? 'no answer'}`);
    });
    await this.fillService.noteCatalogue(items);
    return { items, errors };
  }

  /** New on wcostream (26 Nov 2026): the shows its lists gained in the last `days`, with whether each is in Sonarr. */
  @Get('library/new')
  async libraryNew(@Query('days') days?: string) {
    const { items, errors } = await this.catalogue();
    return { catalogueErrors: errors, ...(await this.fillService.newOnWco(items, days ? Number(days) : undefined)) };
  }

  @Get('library/gaps')
  async libraryGaps() {
    const { items, errors } = await this.catalogue();
    return { catalogueSize: items.length, catalogueErrors: errors, rows: await this.fillService.libraryGaps(items) };
  }

  @Get('library/search')
  async librarySearch(@Query('q') q: string) {
    return this.fillService.inSonarr(searchCatalogue((await this.catalogue()).items, q));
  }

  @Post('links')
  @UseGuards(JsonRequestGuard)
  links(@Body() body: any) {
    return this.fillService.setLinks(body);
  }

  /** "The link is right" (18 Nov 2026): the nightly link check leaves this show's link alone from now on. */
  /** "Check every link" (19 Nov 2026): every followed show's link and wcostream count, checked behind the screen. */
  @Post('followed/check-links')
  @UseGuards(JsonRequestGuard)
  checkLinks(@Body() body: any) {
    return this.fillService.checkLinks(undefined, !!body?.all);
  }

  /** The files in a show's second folders, with the episode each would be (22 Nov 2026). */
  @Get('show/split')
  async splitFiles(@Query('seriesId') seriesId: string) {
    return (await this.fillService.splitFiles(Number(seriesId))).map(({ raw, ...f }) => f);
  }

  @Post('show/split/import')
  @UseGuards(JsonRequestGuard)
  importSplit(@Body() body: any) {
    return this.fillService.importSplit(body);
  }

  /** Hand a whole followed show to Sonarr and stop following it (22 Nov 2026). */
  @Post('followed/hand-off')
  @UseGuards(JsonRequestGuard)
  handOff(@Body() body: any) {
    return this.fillService.handShowToSonarr(body);
  }

  /** Fill first (26 Nov 2026): { slug, first: true | episodes a night | false }. */
  @Post('links/first')
  @UseGuards(JsonRequestGuard)
  fillFirst(@Body() body: any) {
    return this.fillService.setFirst(body);
  }

  @Post('links/no-swap')
  @UseGuards(JsonRequestGuard)
  noSwap(@Body() body: any) {
    return this.fillService.setNoSwap(body);
  }

  /** "Season N was never dubbed" (23 Nov 2026): { slug, seasons: [2] }; seasons: [] counts them again. */
  @Post('links/not-dubbed')
  @UseGuards(JsonRequestGuard)
  notDubbed(@Body() body: any) {
    return this.fillService.setNotDubbed(body);
  }

  /** "Sonarr season N is on this other wcostream page" (23 Nov 2026): { slug, page, season }. */
  @Post('links/season-page')
  @UseGuards(JsonRequestGuard)
  seasonPage(@Body() body: any) {
    return this.fillService.linkSeasonPage(body);
  }

  /** "This wcostream show is Sonarr season N" (21 Nov 2026): { slug, season } or { slug, season: null }. */
  @Post('links/season')
  @UseGuards(JsonRequestGuard)
  linkSeason(@Body() body: any) {
    return this.fillService.setSeason(body);
  }

  @Post('links/ok')
  @UseGuards(JsonRequestGuard)
  linkOk(@Body() body: any) {
    return this.fillService.linkIsRight(body);
  }

  @Post('fill/plan-now')
  @UseGuards(JsonRequestGuard)
  /** "Fill now" (18 Nov 2026): plan what is due for every followed show and start it straight away; answers the runs it made. */
  planNow() {
    return this.fillService.nightlyPlan({ now: true });
  }

  /** The summary of the last automatic runs, for the home screen's "Last night" card; {} before the first (a bare null sends no body). */
  @Get('fill/last-run')
  async lastRun() {
    return (await this.fillService.getLastRun()) ?? {};
  }

  @Post('fill/jobs/:id/retry')
  @UseGuards(JsonRequestGuard)
  retryFill(@Param('id') id: string): Promise<FillJob> {
    return this.fillService.retry(id);
  }

  // ---- Queue controls and the "Needs you" list (11 Nov 2026) ----
  @Post('fill/jobs/:id/retry/:episodeId')
  @UseGuards(JsonRequestGuard)
  retryEpisode(@Param('id') id: string, @Param('episodeId') episodeId: string): Promise<FillJob> {
    return this.fillService.retryEpisode(id, Number(episodeId));
  }

  @Post('fill/jobs/:id/next')
  @UseGuards(JsonRequestGuard)
  runNext(@Param('id') id: string): Promise<FillJob> {
    return this.fillService.runNext(id);
  }

  @Post('fill/jobs/:id/dismiss/:episodeId')
  @UseGuards(JsonRequestGuard)
  dismiss(@Param('id') id: string, @Param('episodeId') episodeId: string) {
    return this.fillService.dismiss(id, Number(episodeId));
  }

  @Get('fill/state')
  queueState() {
    return this.fillService.queueState();
  }

  @Post('fill/pause')
  @UseGuards(JsonRequestGuard)
  pause(@Body() body: any) {
    return this.fillService.setPaused(!!body?.paused);
  }

  @Get('attention')
  attention() {
    return this.fillService.attention();
  }

  // ---- Old downloads left in staging (18 Nov 2026) ----
  @Get('fill/staging')
  async staging() {
    const { dirs, ...summary } = await this.fillService.staging();
    return summary;
  }

  @Post('fill/staging/clear')
  @UseGuards(JsonRequestGuard)
  clearStaging() {
    return this.fillService.clearStaging();
  }

  @Get('sonarr/defaults')
  addDefaults() {
    return this.fillService.addDefaults();
  }

  @Post('sonarr/add')
  @UseGuards(JsonRequestGuard)
  addToSonarr(@Body() body: any) {
    return this.fillService.addToSonarr(body);
  }

  @Post('followed/recount')
  @UseGuards(JsonRequestGuard)
  recount() {
    return this.fillService.recount();
  }

  // Settings screen (12 Nov 2026). The AnimeSchedule token goes in and never comes back out: only "saved or not".
  @Get('settings')
  async settings() {
    return { ...this.fillService.getSettings(), hasDubToken: await this.dubCalendar.hasToken() };
  }

  @Post('settings')
  @UseGuards(SetupGuard, JsonRequestGuard)
  async saveSettings(@Body() body: any) {
    if (body?.dubToken) await this.dubCalendar.setToken(body.dubToken);
    return { ...(await this.fillService.setSettings(body)), hasDubToken: await this.dubCalendar.hasToken() };
  }

  // Dub calendar (12 Nov 2026): English dub air dates from AnimeSchedule.net, matched to Sonarr.
  @Get('dub-calendar')
  async dubCalendarRows(@Query('refresh') refresh: string | undefined, @Res({ passthrough: true }) res: Response) {
    const c = await this.dubCalendar.calendar(refresh === '1');
    if (c.needsToken) return c;
    // Only what is already cached: a list that is not is fetched behind, and the screen asks again.
    const lists = ['dubbed', 'cartoon', 'subbed'] as const;
    const got = await Promise.all(lists.map((l) => this.appService.cachedContentList(l)));
    const items: CatalogueItem[] = got.flatMap((list, i) =>
      (list ?? []).filter((x) => x.kind === 'series').map((x) => ({ name: x.name, path: x.path, list: lists[i] })));
    const rows = await this.fillService.calendarInfo(c.rows, items);
    if (got.some((l) => !l) || this.dubCalendar.refreshing || this.fillService.calendarWarming || this.fillService.seriesRefreshing) res.setHeader('X-Calendar-Refreshing', '1');
    return { ...c, rows };
  }

  @Get('dub-calendar/series/:id')
  dubCalendarSeries(@Param('id') id: string) {
    return this.dubCalendar.forSeries(Number(id));
  }

  @Get('get-website')
  getWebsite() {
    return 'https://www.wcostream.tv/';
  }

  @Get('get-all-dubbed-anime-names')
  getAllDubbedAnimes(): Promise<ContentItem[]> {
    return this.appService.getContentList('dubbed');
  }

  @Get('get-all-subbed-anime-names')
  getAllSubbedAnimes(): Promise<ContentItem[]> {
    return this.appService.getContentList('subbed');
  }

  @Get('get-all-cartoon-names')
  getAllCartoons(): Promise<ContentItem[]> {
    return this.appService.getContentList('cartoon');
  }

  @Get('get-all-movie-names')
  getAllMovies(): Promise<ContentItem[]> {
    return this.appService.getContentList('movie');
  }

  @Get('get-all-ova-names')
  getAllOvas(): Promise<ContentItem[]> {
    return this.appService.getContentList('ova');
  }

  @Post('download-anime')
  @HttpCode(HttpStatus.ACCEPTED)
  getShow(@Body() body: CreateShow): Promise<DownloadJob> {
    return this.downloadService.startShowDownload(body);
  }

  @Post('download-batch')
  @HttpCode(HttpStatus.ACCEPTED)
  batchDownload(@Body() body: BatchDownload): Promise<DownloadJob[]> {
    return this.downloadService.startBatchDownload(body);
  }

  @Post('download-single-episode')
  @HttpCode(HttpStatus.ACCEPTED)
  getSingleEpisode(@Body() body: SingleEpisodeReq): Promise<DownloadJob> {
    // e.g. that-time-i-got-reincarnated-as-a-slime-episode-2-english-dubbed
    return this.downloadService.startEpisodeDownload(body?.name);
  }

  @Post('process-anime')
  @HttpCode(HttpStatus.OK)
  processShow(@Body() body: ProcessShow): Promise<PostProcessResult> {
    const slug = normalizeSlug(body?.name, true);
    return this.downloadService.postProcess(
      this.downloadService.showFolder(slug),
    );
  }

  @Get('downloads')
  listDownloads(): DownloadJob[] {
    return this.downloadService.listJobs();
  }

  @Get('downloads/:id')
  getDownload(@Param('id') id: string): DownloadJob {
    const job = this.downloadService.getJob(id);
    if (!job) {
      throw new NotFoundException(`Download ${id} not found`);
    }
    return job;
  }

  @Get('webhooks')
  listWebhooks(): string[] {
    return this.downloadService.listWebhooks();
  }

  @Post('webhooks')
  @UseGuards(JsonRequestGuard)
  @HttpCode(HttpStatus.CREATED)
  addWebhook(@Body() body: WebhookReq): Promise<string[]> {
    return this.downloadService.addWebhook(body?.url);
  }

  // The URL must be percent-encoded (encodeURIComponent) to fit in one path segment.
  @Delete('webhooks/:url')
  @UseGuards(JsonRequestGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  removeWebhook(@Param('url') url: string): void {
    if (!this.downloadService.removeWebhook(url)) {
      throw new NotFoundException(`Webhook ${url} not found`);
    }
  }
}
