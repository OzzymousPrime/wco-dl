import {
  BadRequestException, HttpException, HttpStatus, Inject, Injectable, Logger, OnModuleInit, Optional,
} from '@nestjs/common';
import axios from 'axios';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { APP_CONFIG } from './app-config.provider';
import { AppConfig } from './config';
import { FillService } from './fill.service';
import { JsonFileStore } from './json-file-store';

/**
 * Setup and Settings: the connections a person would otherwise type into .env, saved from the browser instead.
 *
 * - What is saved here wins over the value the container started with; clearing it falls back to that value. So an
 *   install that only ever used .env behaves exactly as before.
 * - Saved in connections.json in the config folder. It holds the Sonarr key, so it is written owner-only where the
 *   file system allows, and no answer from this service ever contains a key, a token or the password.
 * - "Test and save": a connection is saved only after it has worked once. A wrong key never replaces a right one.
 * - The address and its key travel together: a new address must come with the key typed again, or anyone who can
 *   open the page could point wco-dl at their own server and be sent the key.
 * - An optional password (ADMIN_PASSWORD, or set on the page) locks these settings. The rest of the app stays open.
 */

type ConnectionKey = 'sonarrUrl' | 'sonarrApiKey' | 'sonarrImportBase' | 'notifyUrl' | 'notifyToken' | 'publicUrl';
const KEYS: ConnectionKey[] = ['sonarrUrl', 'sonarrApiKey', 'sonarrImportBase', 'notifyUrl', 'notifyToken', 'publicUrl'];
const ENV_NAME: Record<ConnectionKey, string> = {
  sonarrUrl: 'SONARR_URL', sonarrApiKey: 'SONARR_API_KEY', sonarrImportBase: 'SONARR_IMPORT_BASE',
  notifyUrl: 'NOTIFY_URL', notifyToken: 'NOTIFY_TOKEN', publicUrl: 'PUBLIC_URL',
};
/** A saved empty string means "none, on purpose" (for example: Sonarr sees the same path), not "use the start-up value". */
type Saved = Partial<Record<ConnectionKey, string>> & { lock?: { salt: string; hash: string } };
/** Where a value in use came from: saved on the page, the container's environment (.env), or the built-in default. */
type Source = 'saved' | 'env' | 'default';

export interface Check { state: 'ok' | 'bad' | 'unset' | 'waiting'; message: string }
export interface SetupStatus {
  ready: boolean;
  sonarr: Check & { url: string; urlFrom: Source; hasKey: boolean; keyFrom: Source; version?: string };
  folder: Check & { outputBase: string; importBase: string; importBaseFrom: Source; sonarrPath: string };
  helper: Check & { url: string };
  extras: { notifyUrl: string; notifyFrom: Source; hasNotifyToken: boolean; publicUrl: string; publicFrom: Source };
  lock: { on: boolean; from: 'env' | 'saved' | null };
}

const SESSION_MS = 12 * 60 * 60 * 1000;
const TRIES = 5;
const TRIES_WINDOW_MS = 60 * 1000;
export const SESSION_COOKIE = 'wco_admin';

const stripSlash = (url: string) => url.replace(/\/+$/, '');
const sha = (s: string) => createHash('sha256').update(s).digest();
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32, (err, key) => (err ? reject(err) : resolve(key))));

/** The path Sonarr uses for a folder under OUTPUT_BASE, given where Sonarr sees OUTPUT_BASE (empty: the same path). */
export function pathForSonarr(folder: string, outputBase: string, importBase: string | undefined): string {
  if (!importBase || !folder.startsWith(outputBase)) return folder;
  const sep = importBase.includes('\\') ? '\\' : '/';
  const rest = folder.slice(outputBase.length).split(/[\\/]/).filter(Boolean);
  return [importBase.replace(/[\\/]+$/, ''), ...rest].join(sep);
}

function httpUrl(value: unknown, what: string): string {
  const text = stripSlash(String(value ?? '').trim());
  let parsed: URL | undefined;
  try { parsed = new URL(text); } catch { /* handled below */ }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new BadRequestException(`${what} must be a web address starting with http:// or https://`);
  }
  return text;
}

@Injectable()
export class SetupService implements OnModuleInit {
  private readonly logger = new Logger(SetupService.name);
  /** The values the container started with, before anything saved was applied. */
  private readonly started: Partial<Record<ConnectionKey, string | undefined>> = {};
  private readonly store: JsonFileStore<Saved>;
  private saved: Saved = {};
  private readonly sessions = new Map<string, number>();
  private failed: number[] = [];
  /**
   * The folder test writes a file into the downloads folder, so it is not repeated on every visit: a pass is
   * remembered for exactly what it proved (this folder, this Sonarr path, this Sonarr and key) until the app restarts.
   * A failure is not remembered, so the page tests again until it passes.
   */
  private folderPass?: { key: string; result: Check & { sonarrPath: string } };
  /** The container's environment: read for ADMIN_PASSWORD and to say whether a value came from .env. */
  protected env: NodeJS.ProcessEnv = process.env;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig, @Optional() private readonly fill?: FillService) {
    for (const k of KEYS) this.started[k] = config[k];
    this.store = new JsonFileStore<Saved>(this.file, () => ({}), (m) => this.logger.warn(m));
  }

  private get file() { return path.join(this.config.configDir, 'connections.json'); }

  async onModuleInit() {
    try {
      this.saved = await this.store.read();
      this.apply();
    } catch (err) {
      // An unreadable file must not stop the app: it runs on the start-up values and the page says what is wrong.
      this.logger.error(`Saved connections not loaded, using the start-up values: ${(err as Error).message}`);
    }
  }

  /** Put the saved values (else the start-up ones) into the one config object every service reads from. */
  private apply() {
    for (const k of KEYS) {
      const v = this.saved[k];
      (this.config as unknown as Record<string, string | undefined>)[k] = v !== undefined ? v || undefined : this.started[k];
    }
    if (!this.config.sonarrUrl) this.config.sonarrUrl = this.started.sonarrUrl ?? 'http://localhost:8989';
  }

  private async change(edit: (saved: Saved) => void) {
    await fs.mkdir(this.config.configDir, { recursive: true });
    this.saved = await this.store.update(edit);
    for (const f of [this.file, this.file + '.bak']) await fs.chmod(f, 0o600).catch(() => undefined);
    this.apply();
  }

  private from(k: ConnectionKey): Source {
    return this.saved[k] !== undefined ? 'saved' : this.env[ENV_NAME[k]] ? 'env' : 'default';
  }

  // ---------- The checks ----------

  private async checkSonarr(url = this.config.sonarrUrl, key = this.config.sonarrApiKey): Promise<Check & { version?: string }> {
    if (!key) return { state: 'unset', message: 'Not connected yet' };
    try {
      const r = await axios.request<any>({ method: 'get', url: `${url}/api/v3/system/status`, timeout: 15000,
        headers: { 'X-Api-Key': key }, validateStatus: () => true });
      if (r.status === 401 || r.status === 403) return { state: 'bad', message: 'Sonarr refused the key. Copy it again from Sonarr: Settings, General, API Key.' };
      if (r.status !== 200 || !r.data?.version || (r.data.appName && r.data.appName !== 'Sonarr')) {
        return { state: 'bad', message: `Something answered at ${url}, but not as Sonarr does. Check the address.` };
      }
      return { state: 'ok', message: `Connected · Sonarr ${r.data.version}`, version: String(r.data.version) };
    } catch (err) {
      return { state: 'bad', message: `No answer from ${url} (${(err as { code?: string }).code ?? 'no reply'}). Check the address, and that wco-dl can reach it from where it runs.` };
    }
  }

  /**
   * Does Sonarr see our download folder? Write a file there, ask Sonarr to list the folder as it would name it,
   * and look for the file. This is the one setting people get wrong, and without it every import fails later.
   * `importBase` is always given: leaving it out must mean "the same path", never "whatever is saved now".
   */
  private async checkFolder(importBase: string | undefined, sonarrOk = true, reuse = false): Promise<Check & { sonarrPath: string }> {
    const { outputBase, sonarrUrl, sonarrApiKey } = this.config;
    const sonarrPath = pathForSonarr(outputBase, outputBase, importBase);
    if (!sonarrOk || !sonarrApiKey) return { state: 'waiting', message: 'Checked once Sonarr is connected', sonarrPath };
    const key = JSON.stringify([outputBase, sonarrPath, sonarrUrl, sha(sonarrApiKey).toString('hex')]);
    if (reuse && this.folderPass?.key === key) return this.folderPass.result;
    const result = await this.testFolder(importBase, sonarrPath, sonarrApiKey);
    if (result.state === 'ok') this.folderPass = { key, result }; else if (this.folderPass?.key === key) this.folderPass = undefined;
    return result;
  }

  private async testFolder(importBase: string | undefined, sonarrPath: string, sonarrApiKey: string): Promise<Check & { sonarrPath: string }> {
    const { outputBase, sonarrUrl } = this.config;
    const name = `.wco-dl-check-${randomBytes(6).toString('hex')}`;
    const marker = path.join(outputBase, name);
    try {
      await fs.mkdir(outputBase, { recursive: true });
      await fs.writeFile(marker, 'wco-dl setup check: safe to delete\n');
    } catch (err) {
      return { state: 'bad', sonarrPath, message: `wco-dl cannot write to its download folder ${outputBase} (${(err as { code?: string }).code ?? 'error'}). Check the folder exists and who owns it (PUID and PGID).` };
    }
    try {
      const r = await axios.request<any>({ method: 'get', url: `${sonarrUrl}/api/v3/filesystem`, timeout: 20000,
        // Without the last flag Sonarr reads a path that has no trailing slash as a half-typed name and lists its
        // parent instead (seen on Sonarr 5, 16 Nov 2026): the file is never found and every mapping looks wrong.
        params: { path: sonarrPath, includeFiles: true, allowFoldersWithoutTrailingSlashes: true }, headers: { 'X-Api-Key': sonarrApiKey } });
      const seen = (r.data?.files ?? []).some((f: { name?: string }) => f?.name === name);
      return seen
        ? { state: 'ok', sonarrPath, message: importBase ? `Sonarr sees it at ${sonarrPath}` : 'Sonarr sees it at the same path' }
        : { state: 'bad', sonarrPath, message: `Sonarr does not see the test file at ${sonarrPath}. Say where Sonarr sees this folder.` };
    } catch (err) {
      return { state: 'bad', sonarrPath, message: `Sonarr could not list ${sonarrPath}: ${(err as Error).message}` };
    } finally {
      await fs.rm(marker, { force: true }).catch(() => undefined);
    }
  }

  private async checkHelper(): Promise<Check> {
    const url = this.config.byparrUrl;
    try {
      await axios.request({ method: 'get', url: `${url}/`, timeout: 10000, maxRedirects: 0, validateStatus: () => true });
      return { state: 'ok', message: 'Answering' };
    } catch (err) {
      return { state: 'bad', message: `No answer from the Cloudflare helper (Byparr) at ${url} (${(err as { code?: string }).code ?? 'no reply'}). Downloads fail when wcostream asks for a Cloudflare check.` };
    }
  }

  async status(): Promise<SetupStatus> {
    const [sonarr, helper] = await Promise.all([this.checkSonarr(), this.checkHelper()]);
    const folder = await this.checkFolder(this.config.sonarrImportBase, sonarr.state === 'ok', true);
    const lock = this.lockState();
    return {
      ready: sonarr.state === 'ok' && folder.state === 'ok',
      sonarr: { ...sonarr, url: this.config.sonarrUrl, urlFrom: this.from('sonarrUrl'), hasKey: !!this.config.sonarrApiKey, keyFrom: this.from('sonarrApiKey') },
      folder: { ...folder, outputBase: this.config.outputBase, importBase: this.config.sonarrImportBase ?? '', importBaseFrom: this.from('sonarrImportBase') },
      helper: { ...helper, url: this.config.byparrUrl },
      extras: { notifyUrl: this.config.notifyUrl ?? '', notifyFrom: this.from('notifyUrl'), hasNotifyToken: !!this.config.notifyToken,
        publicUrl: this.config.publicUrl ?? '', publicFrom: this.from('publicUrl') },
      lock: { on: lock.on, from: lock.from },
    };
  }

  /** The folders Sonarr can see under a path (none given: its drives or root), for picking the download folder. */
  async folders(dir?: string): Promise<{ parent: string; directories: { name: string; path: string }[] }> {
    const { sonarrUrl, sonarrApiKey } = this.config;
    if (!sonarrApiKey) throw new BadRequestException('Connect Sonarr first');
    try {
      const r = await axios.request<any>({ method: 'get', url: `${sonarrUrl}/api/v3/filesystem`, timeout: 20000,
        params: { path: dir || undefined, includeFiles: false, allowFoldersWithoutTrailingSlashes: true }, headers: { 'X-Api-Key': sonarrApiKey } });
      const directories = (r.data?.directories ?? []).slice(0, 500).map((d: { name?: string; path?: string }) => ({ name: String(d.name ?? ''), path: String(d.path ?? '') }));
      return { parent: String(r.data?.parent ?? ''), directories };
    } catch (err) {
      throw new BadRequestException(`Sonarr could not list that folder: ${(err as Error).message}`);
    }
  }

  // ---------- Saving ----------

  async saveSonarr(body: { url?: unknown; apiKey?: unknown }): Promise<SetupStatus> {
    const url = httpUrl(body?.url, "Sonarr's address");
    const typed = String(body?.apiKey ?? '').trim();
    if (!typed && url !== this.config.sonarrUrl) throw new BadRequestException('Type the API key again when you change the address');
    const key = typed || this.config.sonarrApiKey;
    if (!key) throw new BadRequestException('Paste the API key from Sonarr: Settings, General, API Key');
    const check = await this.checkSonarr(url, key);
    if (check.state !== 'ok') throw new BadRequestException(check.message);
    await this.change((s) => { s.sonarrUrl = url; if (typed) s.sonarrApiKey = typed; });
    this.fill?.sonarrChanged();
    return this.status();
  }

  async saveFolder(body: { importBase?: unknown }): Promise<SetupStatus> {
    const importBase = String(body?.importBase ?? '').trim();
    if (importBase.length > 1000) throw new BadRequestException('That path is too long');
    const check = await this.checkFolder(importBase || undefined);
    if (check.state !== 'ok') throw new BadRequestException(check.message);
    await this.change((s) => { s.sonarrImportBase = importBase; });
    return this.status();
  }

  async saveExtras(body: { notifyUrl?: unknown; notifyToken?: unknown; publicUrl?: unknown }): Promise<SetupStatus> {
    const notifyUrl = String(body?.notifyUrl ?? '').trim() ? httpUrl(body.notifyUrl, 'The message address') : '';
    const publicUrl = String(body?.publicUrl ?? '').trim() ? httpUrl(body.publicUrl, "This app's address") : '';
    const token = String(body?.notifyToken ?? '').trim();
    const moved = notifyUrl !== (this.config.notifyUrl ?? '');
    await this.change((s) => {
      s.notifyUrl = notifyUrl;
      s.publicUrl = publicUrl;
      // The token belongs to the address it was typed for: a new address starts without one.
      if (token) s.notifyToken = token; else if (moved) s.notifyToken = '';
    });
    return this.status();
  }

  /** Forget what was saved for one part and go back to the values the container started with. */
  async reset(body: { part?: unknown }): Promise<SetupStatus> {
    const parts: Record<string, ConnectionKey[]> = { sonarr: ['sonarrUrl', 'sonarrApiKey'], folder: ['sonarrImportBase'], extras: ['notifyUrl', 'notifyToken', 'publicUrl'] };
    const keys = parts[String(body?.part)];
    if (!keys) throw new BadRequestException('Nothing by that name to reset');
    await this.change((s) => { for (const k of keys) delete s[k]; });
    if (keys.includes('sonarrUrl')) this.fill?.sonarrChanged();
    return this.status();
  }

  // ---------- The lock ----------

  private lockState(): { on: boolean; from: 'env' | 'saved' | null } {
    if (this.env.ADMIN_PASSWORD) return { on: true, from: 'env' };
    return this.saved.lock ? { on: true, from: 'saved' } : { on: false, from: null };
  }

  private token(cookieHeader: string | undefined): string | undefined {
    for (const part of String(cookieHeader ?? '').split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === SESSION_COOKIE) return rest.join('=');
    }
    return undefined;
  }

  /** May this browser see and change the settings? Always, while no password is set. */
  authorised(cookieHeader: string | undefined): boolean {
    if (!this.lockState().on) return true;
    const token = this.token(cookieHeader);
    const until = token ? this.sessions.get(token) : undefined;
    if (!token || !until) return false;
    if (until < Date.now()) { this.sessions.delete(token); return false; }
    return true;
  }

  /** What any page may know without the password: whether to send a newcomer to setup, and whether it is locked. */
  state(cookieHeader: string | undefined) {
    return { sonarr: !!this.config.sonarrApiKey, locked: this.lockState().on, unlocked: this.authorised(cookieHeader) };
  }

  private session(): string {
    const now = Date.now();
    for (const [t, until] of this.sessions) if (until < now) this.sessions.delete(t);
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, now + SESSION_MS);
    return token;
  }

  /** Check the password and start a session. Five wrong tries in a minute and the door stays shut for the rest of it. */
  async unlock(password: unknown): Promise<string> {
    const lock = this.lockState();
    if (!lock.on) return this.session();
    const now = Date.now();
    this.failed = this.failed.filter((t) => now - t < TRIES_WINDOW_MS);
    if (this.failed.length >= TRIES) throw new HttpException('Too many wrong tries. Wait a minute.', HttpStatus.TOO_MANY_REQUESTS);
    const given = String(password ?? '');
    const right = lock.from === 'env'
      ? timingSafeEqual(sha(given), sha(String(this.env.ADMIN_PASSWORD)))
      : timingSafeEqual(await derive(given, this.saved.lock!.salt), Buffer.from(this.saved.lock!.hash, 'hex'));
    if (!right) { this.failed.push(now); throw new HttpException('That is not the password', HttpStatus.UNAUTHORIZED); }
    return this.session();
  }

  signOut(cookieHeader: string | undefined) {
    const token = this.token(cookieHeader);
    if (token) this.sessions.delete(token);
  }

  /** Set, change or (with an empty password) remove the page's password. Returns a session for the browser that set it. */
  async setLock(body: { password?: unknown }): Promise<string | undefined> {
    if (this.env.ADMIN_PASSWORD) throw new BadRequestException('The password is set by ADMIN_PASSWORD where wco-dl is started: change it there');
    const password = String(body?.password ?? '');
    if (!password) {
      await this.change((s) => { delete s.lock; });
      this.sessions.clear();
      return undefined;
    }
    if (password.length < 8) throw new BadRequestException('Use at least 8 characters');
    const salt = randomBytes(16).toString('hex');
    const hash = (await derive(password, salt)).toString('hex');
    await this.change((s) => { s.lock = { salt, hash }; });
    this.sessions.clear();
    return this.session();
  }
}
