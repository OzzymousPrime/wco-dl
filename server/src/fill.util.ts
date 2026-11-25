/**
 * Pure helpers for the episode map and fill queue (11 Nov 2026). No I/O here, so all of it is unit-tested.
 * The rules come from a first, script-only gap filler and what went wrong on its first nights:
 * - a downloaded file must name the episode that was asked for, or it is kept for a look;
 * - "Episode 1145.5" is a part two and never episode 1145;
 * - premium-only links are recognised so the episode can be handed to Sonarr.
 */

export interface ShowLink {
  slug: string;
  language?: 'dub' | 'sub';
  /**
   * Set when an episode's own link was pasted (18 Nov 2026): the slug is then the show's, guessed from the episode's
   * name, and `link` is the episode page, which the server can match against the show's listing.
   */
  episode?: { link: string; season?: number; number: number };
}

const WCO_HOST = /^(www\.)?wcostream\.[a-z]+$/i;

/** "https://www.wcostream.tv/anime/re-zero-.../?season=all&lang=dub" -> { slug, language }. Also takes a bare slug. */
/** A wco show name as it appears in its address: letters, digits, hyphens and percent-encoded characters ("ranma-%C2%BD-2024"). */
export const SLUG = /^[a-z0-9](?:[a-z0-9-]|%[0-9a-f]{2})*$/i;

// An episode's page name: "overgeared-episode-8-english-dubbed", "show-season-2-episode-5-english-subbed".
const EPISODE_NAME = /^(.+?)-(?:season-(\d+)-)?episode-(\d+)(?:-.*)?$/;
const EPISODE_LANG = /-english-(dubbed|subbed)$/;

/**
 * An episode's page name as { slug, season, number, language }, or undefined when it is not one. A bare name counts
 * only when it ends in "-english-dubbed" or "-english-subbed", so a show whose own name has "episode-2" in it is not
 * mistaken for an episode; a link's last part counts either way, as show pages live under /anime/.
 */
export function episodeName(name: string, fromLink: boolean): { slug: string; season?: number; number: number; language?: 'dub' | 'sub' } | undefined {
  const lower = name.toLowerCase();
  const lang = EPISODE_LANG.exec(lower);
  if (!fromLink && !lang) return undefined;
  const m = EPISODE_NAME.exec(lower);
  if (!m) return undefined;
  return { slug: m[1], season: m[2] ? Number(m[2]) : undefined, number: Number(m[3]),
    language: lang ? (lang[1] === 'dubbed' ? 'dub' : 'sub') : undefined };
}

export function parseShowLink(input: string): ShowLink {
  const text = String(input ?? '').trim();
  if (!text) throw new Error('Paste a wcostream show link');
  if (SLUG.test(text)) {
    const ep = episodeName(text, false);
    if (!ep) return { slug: text.toLowerCase() };
    return { slug: ep.slug, language: ep.language,
      episode: { link: `https://www.wcostream.tv/${text.toLowerCase()}`, season: ep.season, number: ep.number } };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('That is not a link');
  }
  if (!WCO_HOST.test(url.hostname)) throw new Error('Only wcostream links are supported');
  const parts = url.pathname.split('/').filter(Boolean);
  const i = parts.indexOf('anime');
  const slug = (i >= 0 ? parts[i + 1] : parts[parts.length - 1]) ?? '';
  if (!SLUG.test(slug)) throw new Error('No show in that link');
  const lang = url.searchParams.get('lang');
  const language = lang === 'dub' || lang === 'sub' ? lang : undefined;
  const ep = i < 0 ? episodeName(slug, true) : undefined;
  if (ep) {
    return { slug: ep.slug, language: language ?? ep.language,
      episode: { link: `https://${url.hostname.toLowerCase()}/${slug.toLowerCase()}`, season: ep.season, number: ep.number } };
  }
  return { slug: slug.toLowerCase(), language };
}

/** Lower-case, accents and years dropped, letters and digits only: "Re: ZERO (2016)" -> "rezero". */
export function normaliseTitle(s: string): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    // A release year goes ("Ducktales (2017)"), a number that is part of the name stays: "Mao 2099" lost its 2099 and
    // became "mao", so the wcostream show MAO was linked to Demon Lord 2099 (25 Nov 2026).
    .replace(/\((19|20)\d\d\)|\b(19|20)\d\d\b/g, (y) => (Number(y.replace(/\D/g, '')) <= new Date().getFullYear() + 2 ? ' ' : y))
    .replace(/[^a-z0-9]+/g, '');
}

export interface SeriesLike {
  id: number;
  title: string;
  year?: number;
  titleSlug?: string;
  path?: string;
  alternateTitles?: { title: string }[];
}

/** Is one of the series' names exactly the slug's? Only such a match is linked by a look-up by itself (25 Nov 2026). */
export function namedAs(slug: string, s: SeriesLike): boolean {
  return exactOnly(slug, s);
}
function exactOnly(slug: string, s: SeriesLike): boolean {
  let name = slug;
  try { name = decodeURIComponent(slug); } catch { /* keep it as written */ }
  const want = normaliseTitle(name.replace(/-/g, ' ').replace(/\b(english|dubbed|subbed|dub|sub)\b/g, ''));
  return !!want && [s.title, s.titleSlug ?? '', ...(s.alternateTitles ?? []).map((a) => a.title)]
    .flatMap((t) => [t, t.replace(/&/g, ' ')]).map(normaliseTitle).includes(want);
}

/** Sonarr series whose title, slug or alternate title matches the wco slug. Exact matches first. */
export function matchSeries<T extends SeriesLike>(slug: string, series: T[]): T[] {
  // A link's name may be percent-encoded ("ranma-%c2%bd-2024" is "Ranma ½ (2024)"; 19 Nov 2026 it was flagged as another show).
  let name = slug;
  try { name = decodeURIComponent(slug); } catch { /* keep it as written */ }
  const want = normaliseTitle(name.replace(/-/g, ' ').replace(/\b(english|dubbed|subbed|dub|sub)\b/g, ''));
  if (!want) return [];
  // Each name also without its "&": a link drops it ("welsh-shedar" is "Welsh & Shedar"; 19 Nov 2026 it was flagged).
  const keys = (s: T) => [s.title, s.titleSlug ?? '', ...(s.alternateTitles ?? []).map((a) => a.title)]
    .flatMap((t) => [t, t.replace(/&/g, ' ')]).map(normaliseTitle).filter(Boolean);
  const exact = series.filter((s) => keys(s).includes(want));
  if (exact.length) return exact;
  return series
    .filter((s) => keys(s).some((k) => k.length > 3 && (k.startsWith(want) || want.startsWith(k))))
    .slice(0, 8);
}

/** The last percentage in a chunk of downloader output (tqdm: "Downloading:  43%|####"), or undefined. */
export function parseProgress(chunk: string): number | undefined {
  const all = [...String(chunk).matchAll(/(\d{1,3})%\|/g)];
  if (!all.length) return undefined;
  const n = Number(all[all.length - 1][1]);
  return n >= 0 && n <= 100 ? n : undefined;
}

/** Premium-only episode links in downloader output. */
export function parsePremium(text: string): string[] {
  return [...String(text).matchAll(/Skipping (https?:\/\/\S+), it is only available to WCO Premium/g)].map((m) => m[1]);
}

/** Season and episode a wco file name gives, or the bare episode number. Part twos ("1145.5") give nothing. */
export function fileEpisode(name: string): { season?: number; episode: number } | undefined {
  const n = String(name);
  let m = n.match(/\bS(\d{1,2})E(\d{1,4})(?!\d|\.\d)/i);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = n.match(/season\s*(\d+)\s*episode\s*(\d+)(?!\d|\.\d)/i);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = n.match(/episode\s*(\d+)(?!\d|\.\d)/i);
  if (m) return { episode: Number(m[1]) };
  return undefined;
}

/**
 * Does a downloaded file name match the episode that was asked for?
 * Season numbering: S/E must match (a bare "Episode N" must match the episode number).
 * Straight-through numbering (One Piece): the number must be the absolute episode number; wco writes "S01E1104".
 */
export function fileMatches(
  name: string,
  want: { season: number; episode: number; absolute?: number },
  absoluteNumbering: boolean,
): boolean {
  const got = fileEpisode(name);
  if (!got) return false;
  if (absoluteNumbering) return want.absolute !== undefined && got.episode === want.absolute;
  return got.episode === want.episode && (got.season === undefined || got.season === want.season);
}

/** "eng/jpn" -> true. Untagged audio is decided by the caller from the file name. */
export function hasEnglish(audio: string[] | string): boolean {
  const list = Array.isArray(audio) ? audio : String(audio ?? '').split(/[\/,\s]+/);
  return list.some((l) => ['eng', 'en', 'english'].includes(l.toLowerCase()));
}

/** Verdict for a dub swap from ffprobe's audio tags. */
export function dubVerdict(audioTags: string[], fileName: string): { ok: boolean; why: string } {
  if (hasEnglish(audioTags)) return { ok: true, why: `audio ${audioTags.join('/')}` };
  const tagged = audioTags.filter((l) => l && l !== 'und');
  if (tagged.length) return { ok: false, why: `audio is ${audioTags.join('/')}, no English track` };
  const named = /dubbed/i.test(fileName);
  return { ok: named, why: `audio untagged; name ${named ? 'says' : 'does not say'} Dubbed` };
}

// ---------- Library gaps (11 Nov 2026): match Sonarr series to wcostream's own catalogue by name ----------
export interface CatalogueItem { name: string; path: string; list: 'dubbed' | 'cartoon' | 'subbed' }
export interface CatalogueMatch { slug: string; name: string; language: 'dub' | 'sub' }

/** A catalogue name without its audio words: "Naruto English Dubbed" -> "naruto". */
export function catalogueKey(name: string): string {
  return normaliseTitle(String(name ?? '').replace(/\b(english|dubbed|subbed|dub|sub)\b/gi, ' '));
}

const VALID_SLUG = SLUG;
const asMatch = (i: CatalogueItem): CatalogueMatch => ({ slug: i.path.toLowerCase(), name: i.name, language: i.list === 'subbed' ? 'sub' : 'dub' });

/** Catalogue entries by normalised name and by normalised slug. Entries whose slug the map cannot open are left out. */
export function indexCatalogue(items: CatalogueItem[]): Map<string, CatalogueItem[]> {
  const index = new Map<string, CatalogueItem[]>();
  for (const i of items) {
    if (!VALID_SLUG.test(i.path)) continue;
    for (const k of new Set([catalogueKey(i.name), catalogueKey(i.path.replace(/-/g, ' '))])) {
      if (!k) continue;
      const had = index.get(k);
      if (had) had.push(i); else index.set(k, [i]);
    }
  }
  return index;
}

/**
 * The wcostream shows a Sonarr series could be. "exact": one show has the same name (years and punctuation aside).
 * "maybe": several share the name, or only the start of the name matches, so a person picks. Dubbed and cartoon
 * entries win over subbed ones: a subbed entry is offered only when nothing else matches.
 */
export function matchCatalogue(series: SeriesLike, index: Map<string, CatalogueItem[]>): { kind: 'exact' | 'maybe' | 'none'; candidates: CatalogueMatch[] } {
  const keys = [...new Set([series.title, (series.titleSlug ?? '').replace(/-/g, ' '), ...(series.alternateTitles ?? []).map((a) => a.title)]
    .map(normaliseTitle).filter(Boolean))];
  const tidy = (found: CatalogueItem[]) => {
    const dubbed = found.filter((i) => i.list !== 'subbed');
    const seen = new Set<string>();
    return (dubbed.length ? dubbed : found).map(asMatch).filter((m) => !seen.has(m.slug) && seen.add(m.slug));
  };
  const exact = tidy(keys.flatMap((k) => index.get(k) ?? []));
  if (exact.length === 1) return { kind: 'exact', candidates: exact };
  if (exact.length > 1) return { kind: 'maybe', candidates: exact.slice(0, 8) };
  const long = keys.filter((k) => k.length > 4);
  const near: CatalogueItem[] = [];
  for (const [k, list] of index) {
    if (k.length > 4 && long.some((s) => k.startsWith(s) || s.startsWith(k))) near.push(...list);
  }
  const maybe = tidy(near).slice(0, 8);
  return maybe.length ? { kind: 'maybe', candidates: maybe } : { kind: 'none', candidates: [] };
}

/**
 * Other wcostream shows that could carry a series (23 Nov 2026): for a link that lists nothing (relink) or that lacks
 * seasons (Digimon Fusion's third is "Digimon Xros Wars: Hunters"). Its name matches, then every catalogue entry whose
 * name holds the first two words of one of its names. Shows already linked are left out.
 */
export function alternatives(series: SeriesLike, index: Map<string, CatalogueItem[]>, items: CatalogueItem[], taken: Set<string>, limit = 6): CatalogueMatch[] {
  const seen = new Set<string>();
  const names = [series.title, ...(series.alternateTitles ?? []).map((a) => a.title)].filter(Boolean) as string[];
  const heads = [...new Set(names.map((n) => n.replace(/\(.*?\)/g, ' ').split(/[\s:]+/).filter(Boolean).slice(0, 2).join(' ')))];
  return [...matchCatalogue(series, index).candidates, ...heads.flatMap((h) => searchCatalogue(items, h, 20))]
    .filter((m) => !taken.has(m.slug) && !seen.has(m.slug) && seen.add(m.slug)).slice(0, limit);
}

/** Catalogue entries whose name contains every word of the query; dubbed and cartoon entries first. */
export function searchCatalogue(items: CatalogueItem[], q: string, limit = 12): CatalogueMatch[] {
  const words = String(q ?? '').toLowerCase().split(/\s+/).map(normaliseTitle).filter(Boolean);
  if (words.join('').length < 2) return [];
  const seen = new Set<string>();
  return items
    .filter((i) => VALID_SLUG.test(i.path) && words.every((w) => normaliseTitle(i.name).includes(w)))
    .sort((a, b) => Number(a.list === 'subbed') - Number(b.list === 'subbed') || a.name.length - b.name.length)
    .map(asMatch).filter((m) => !seen.has(m.slug) && seen.add(m.slug)).slice(0, limit);
}

/**
 * What a library file's audio tags say (Sonarr's "jpn/eng", "und", ""): 'dub' when an English track is named,
 * 'undub' when another language is named and English is not, 'unknown' when nothing is named. Most English cartoons
 * here carry "und" (11 Nov 2026: 4,436 of 4,783 files without an English tag), so "no English tag" must never be
 * read as "Japanese": an unlabelled file is only ever replaced when a person picks it.
 */
/** What ffprobe found in a downloaded file. */
export interface Probe { read: boolean; video: boolean; seconds?: number }

/**
 * Fit to import (17 Nov 2026)? It must open, hold a video stream, and run at least 20 seconds and, when Sonarr knows
 * the show's runtime (5 minutes or more), at least 40% of it: a site that packs two 11-minute segments into one episode
 * still passes against a 22-minute runtime, a two-minute error clip does not. No probe (no ffprobe): fit.
 */
export function playVerdict(p: Probe | undefined, runtimeMin?: number): { ok: true } | { ok: false; why: string } {
  if (!p) return { ok: true };
  if (!p.read) return { ok: false, why: 'The file would not open (ffprobe could not read it)' };
  if (!p.video) return { ok: false, why: 'The file has no video in it' };
  if (p.seconds === undefined) return { ok: true };
  if (p.seconds < 20) return { ok: false, why: `The file runs only ${Math.round(p.seconds)} seconds` };
  if (runtimeMin && runtimeMin >= 5 && p.seconds < runtimeMin * 60 * 0.4) {
    return { ok: false, why: `The file runs ${Math.max(1, Math.round(p.seconds / 60))} minutes; this show's episodes run about ${runtimeMin}` };
  }
  return { ok: true };
}

export function audioStatus(audio: string): 'dub' | 'undub' | 'unknown' {
  const tags = String(audio ?? '').toLowerCase().split(/[\/,\s]+/).filter(Boolean);
  if (tags.some((t) => t.startsWith('en'))) return 'dub';
  return tags.some((t) => !['und', 'any', 'zxx', 'mul', 'mis', 'unknown'].includes(t)) ? 'undub' : 'unknown';
}
