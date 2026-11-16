import axios from 'axios';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppConfig } from './config';
import { SetupService } from './setup.service';

/**
 * Setup and Settings, against a fake Sonarr (axios mocked). The rules pinned here: nothing is saved until it has
 * worked once, a key is never sent to an address it was not typed for, no answer ever carries a secret, and what
 * is saved outlives a restart without disturbing an install that only uses .env.
 */
describe('SetupService', () => {
  let dir: string;
  let out: string;
  let asked: { url: string; key?: string; params?: any }[];
  let sonarrSees: (dir: string) => string;       // the folder of ours that Sonarr's path names; '' when it names none
  const KEY = 'right-key-0123456789abcdef';

  const config = (over: Partial<AppConfig> = {}) => ({ sonarrUrl: 'http://sonarr:8989', sonarrApiKey: undefined, sonarrImportBase: undefined,
    byparrUrl: 'http://byparr:8191', configDir: path.join(dir, 'config'), outputBase: out, ...over } as unknown as AppConfig);
  const service = async (cfg: AppConfig, env: Record<string, string> = {}) => {
    const svc = new SetupService(cfg);
    (svc as any).env = env;
    await svc.onModuleInit();
    return svc;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-'));
    out = path.join(dir, 'downloads');
    asked = [];
    sonarrSees = (p) => (p === out ? out : '');
    jest.spyOn(axios, 'request').mockImplementation(async (req: any) => {
      const url = String(req.url);
      const key = req.headers?.['X-Api-Key'];
      asked.push({ url, key, params: req.params });
      if (url.startsWith('http://byparr')) return { status: 307, data: '' };
      if (!url.startsWith('http://sonarr:8989/')) { const e: any = new Error('getaddrinfo ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
      if (url.endsWith('/system/status')) return key === KEY ? { status: 200, data: { appName: 'Sonarr', version: '4.0.9' } } : { status: 401, data: {} };
      if (url.endsWith('/filesystem')) {
        const real = sonarrSees(String(req.params.path));
        const names = real ? await fs.readdir(real).catch(() => []) : [];
        return { status: 200, data: { parent: '/', directories: [{ name: 'tv', path: '/media/tv', type: 'folder' }], files: req.params.includeFiles ? names.map((name) => ({ name })) : [] } };
      }
      return { status: 200, data: [] };
    });
  });
  afterEach(async () => { jest.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });

  it('reports what is missing on a fresh install, without throwing', async () => {
    const svc = await service(config());
    const s = await svc.status();
    expect(s.ready).toBe(false);
    expect(s.sonarr).toMatchObject({ state: 'unset', hasKey: false, urlFrom: 'default' });
    expect(s.folder.state).toBe('waiting');
    expect(s.helper.state).toBe('ok');
    expect(svc.state(undefined)).toEqual({ sonarr: false, locked: false, unlocked: true });
  });

  it('saves a connection only after it has worked, uses it at once, and keeps it over a restart', async () => {
    const cfg = config();
    const svc = await service(cfg);
    await expect(svc.saveSonarr({ url: 'http://sonarr:8989/', apiKey: 'wrong' })).rejects.toThrow(/refused the key/);
    await expect(svc.saveSonarr({ url: 'ftp://sonarr', apiKey: KEY })).rejects.toThrow(/http/);
    await expect(svc.saveSonarr({ url: 'http://sonarr:8989', apiKey: '' })).rejects.toThrow(/Paste the API key/);
    expect(cfg.sonarrApiKey).toBeUndefined();                                    // nothing was saved by the failures
    await expect(fs.access(path.join(dir, 'config', 'connections.json'))).rejects.toThrow();

    const s = await svc.saveSonarr({ url: 'http://sonarr:8989/', apiKey: `  ${KEY} ` });
    expect(s.sonarr).toMatchObject({ state: 'ok', version: '4.0.9', url: 'http://sonarr:8989', urlFrom: 'saved', hasKey: true, keyFrom: 'saved' });
    expect(s.ready).toBe(true);                                                  // Sonarr sees the folder at the same path here
    expect(cfg.sonarrApiKey).toBe(KEY);                                          // the object every other service reads
    expect(JSON.stringify(s)).not.toContain(KEY);                                // no answer carries the key

    const later = config();                                                      // a restart: .env still has no key
    const again = await service(later);
    expect(later.sonarrApiKey).toBe(KEY);
    expect((await again.status()).sonarr.state).toBe('ok');
  });

  it('never sends the key to an address it was not typed for', async () => {
    const svc = await service(config({ sonarrApiKey: KEY }), { SONARR_API_KEY: KEY });
    asked.length = 0;
    await expect(svc.saveSonarr({ url: 'http://elsewhere:8989' })).rejects.toThrow(/Type the API key again/);
    expect(asked).toEqual([]);                                                   // not even a test request
    // Same address, key left blank: the key in use is tested and kept, and it still counts as coming from .env.
    const s = await svc.saveSonarr({ url: 'http://sonarr:8989' });
    expect(s.sonarr).toMatchObject({ state: 'ok', urlFrom: 'saved', keyFrom: 'env' });
    expect(asked.every((a) => a.url.startsWith('http://sonarr:8989/') || a.url.startsWith('http://byparr'))).toBe(true);
  });

  it('leaves an install that only uses .env as it was, and falls back to it on reset', async () => {
    const cfg = config({ sonarrApiKey: KEY, sonarrImportBase: 'D:\\Downloads\\wco-dl' });
    const svc = await service(cfg, { SONARR_URL: 'http://sonarr:8989', SONARR_API_KEY: KEY, SONARR_IMPORT_BASE: 'D:\\Downloads\\wco-dl' });
    expect(cfg).toMatchObject({ sonarrUrl: 'http://sonarr:8989', sonarrApiKey: KEY, sonarrImportBase: 'D:\\Downloads\\wco-dl' });
    sonarrSees = (p) => (p === '/downloads/wco-dl' ? out : '');
    await svc.saveFolder({ importBase: '/downloads/wco-dl' });
    expect(cfg.sonarrImportBase).toBe('/downloads/wco-dl');
    const s = await svc.reset({ part: 'folder' });
    expect(cfg.sonarrImportBase).toBe('D:\\Downloads\\wco-dl');
    expect(s.folder).toMatchObject({ importBaseFrom: 'env', state: 'bad' });
    await expect(svc.reset({ part: 'everything' })).rejects.toThrow(/Nothing by that name/);
  });

  it('checks that Sonarr sees the download folder with a real file, and saves a mapping only when it does', async () => {
    const cfg = config({ sonarrApiKey: KEY });
    const svc = await service(cfg);
    sonarrSees = (p) => (p === '/downloads/wco-dl' ? out : '');                  // Sonarr knows the folder under another name
    const before = await svc.status();
    expect(before.folder).toMatchObject({ state: 'bad', sonarrPath: out });
    expect(before.ready).toBe(false);
    await expect(svc.saveFolder({ importBase: '/media/tv' })).rejects.toThrow(/does not see the test file at \/media\/tv/);
    expect(cfg.sonarrImportBase).toBeUndefined();
    const s = await svc.saveFolder({ importBase: '/downloads/wco-dl' });
    expect(s.folder).toMatchObject({ state: 'ok', importBase: '/downloads/wco-dl', importBaseFrom: 'saved', sonarrPath: '/downloads/wco-dl' });
    expect(s.ready).toBe(true);
    expect(cfg.sonarrImportBase).toBe('/downloads/wco-dl');
    expect(await fs.readdir(out)).toEqual([]);                                   // every test file was cleared away
    // "The same path" can be saved on purpose, over a mapping from .env: an empty answer is kept as an answer.
    sonarrSees = (p) => (p === out ? out : '');
    await svc.saveFolder({ importBase: '' });
    expect(cfg.sonarrImportBase).toBeUndefined();
    expect((await service(config({ sonarrApiKey: KEY, sonarrImportBase: '/from/env' }), { SONARR_IMPORT_BASE: '/from/env' })).state(undefined).sonarr).toBe(true);
  });

  it('says so when it cannot write to the download folder, or the helper does not answer', async () => {
    const blocked = path.join(dir, 'a-file');
    await fs.writeFile(blocked, 'not a folder');
    const svc = await service(config({ sonarrApiKey: KEY, outputBase: path.join(blocked, 'downloads'), byparrUrl: 'http://nowhere:8191' }));
    const s = await svc.status();
    expect(s.folder.state).toBe('bad');
    expect(s.folder.message).toMatch(/cannot write to its download folder/);
    expect(s.helper.state).toBe('bad');
    expect(s.helper.message).toMatch(/Cloudflare helper/);
  });

  it('lists the folders Sonarr can see, for picking one', async () => {
    const svc = await service(config({ sonarrApiKey: KEY }));
    await expect(svc.folders('/media')).resolves.toEqual({ parent: '/', directories: [{ name: 'tv', path: '/media/tv' }] });
    expect(asked[asked.length - 1].params).toMatchObject({ path: '/media', includeFiles: false });
    await expect((await service(config())).folders()).rejects.toThrow(/Connect Sonarr first/);
  });

  it('keeps the message token with the address it was typed for', async () => {
    const cfg = config();
    const svc = await service(cfg);
    let s = await svc.saveExtras({ notifyUrl: 'http://hooks/a', notifyToken: 'tok-123456', publicUrl: 'http://nas:3000/' });
    expect(s.extras).toEqual({ notifyUrl: 'http://hooks/a', notifyFrom: 'saved', hasNotifyToken: true, publicUrl: 'http://nas:3000', publicFrom: 'saved' });
    expect(JSON.stringify(s)).not.toContain('tok-123456');
    s = await svc.saveExtras({ notifyUrl: 'http://hooks/a', publicUrl: '' });      // unchanged address, blank token: kept
    expect(cfg.notifyToken).toBe('tok-123456');
    s = await svc.saveExtras({ notifyUrl: 'http://hooks/b' });                      // new address: starts without a token
    expect(cfg.notifyToken).toBeUndefined();
    expect(s.extras.hasNotifyToken).toBe(false);
    await expect(svc.saveExtras({ notifyUrl: 'hooks/b' })).rejects.toThrow(/http/);
  });

  it('locks the settings behind a password when one is set, and not before', async () => {
    const svc = await service(config());
    expect(svc.authorised(undefined)).toBe(true);
    await expect(svc.setLock({ password: 'short' })).rejects.toThrow(/at least 8/);
    const mine = await svc.setLock({ password: 'correct horse' });
    expect(svc.authorised(undefined)).toBe(false);
    expect(svc.authorised(`other=1; wco_admin=${mine}`)).toBe(true);                // the browser that set it stays in
    expect(svc.authorised('wco_admin=guess')).toBe(false);
    expect(svc.state(undefined)).toMatchObject({ locked: true, unlocked: false });
    const stored = await fs.readFile(path.join(dir, 'config', 'connections.json'), 'utf8');
    expect(stored).not.toContain('correct horse');                                  // only a salted hash is kept

    const again = await service(config());                                          // a restart signs everyone out
    expect(again.authorised(`wco_admin=${mine}`)).toBe(false);
    await expect(again.unlock('wrong')).rejects.toThrow(/not the password/);
    const token = await again.unlock('correct horse');
    expect(again.authorised(`wco_admin=${token}`)).toBe(true);
    again.signOut(`wco_admin=${token}`);
    expect(again.authorised(`wco_admin=${token}`)).toBe(false);
    for (let i = 0; i < 4; i++) await expect(again.unlock('wrong')).rejects.toThrow(/not the password/);
    await expect(again.unlock('correct horse')).rejects.toThrow(/Too many wrong tries/);   // five wrong in a minute: shut, even for the right one

    const back = await service(config());
    const t = await back.unlock('correct horse');
    expect(t).toBeTruthy();
    await back.setLock({ password: '' });                                           // removed: open again
    expect(back.authorised(undefined)).toBe(true);
  });

  it('takes the password from ADMIN_PASSWORD when that is set, and will not change it from the page', async () => {
    const svc = await service(config(), { ADMIN_PASSWORD: 'from the environment' });
    expect(svc.state(undefined)).toMatchObject({ locked: true, unlocked: false });
    await expect(svc.unlock('from the environmen')).rejects.toThrow(/not the password/);
    expect(svc.authorised(`wco_admin=${await svc.unlock('from the environment')}`)).toBe(true);
    await expect(svc.setLock({ password: 'another one' })).rejects.toThrow(/ADMIN_PASSWORD/);
  });

  it('runs on the start-up values when the saved file cannot be read', async () => {
    await fs.mkdir(path.join(dir, 'config'), { recursive: true });
    await fs.writeFile(path.join(dir, 'config', 'connections.json'), '{"sonarrUrl": "http://');
    const cfg = config({ sonarrApiKey: KEY });
    const svc = await service(cfg, { SONARR_API_KEY: KEY });
    expect(cfg.sonarrApiKey).toBe(KEY);
    expect((await svc.status()).sonarr.state).toBe('ok');
  });
});
