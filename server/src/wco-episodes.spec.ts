import { alike, buildListing, gapReason, linkCheck, fileIsEpisode, fileTitle, isListed, latestText, linkTitle, numberingFit, parseEpisodeLinks, pickedBy, realTitle, resolveSources } from './wco-episodes.util';

const page = (items: string) => `<html><body><div>${items}</div></body></html>`;
const a = (cls: string, href: string, lang?: string) => `<a class="${cls}" href="${href}"${lang ? ` data-lang="${lang}"` : ''}>x</a>`;
const U = 'https://www.wcostream.tv/anime/some-show';

describe('what wcostream lists', () => {
  it('reads links by the downloader\'s classes, once each, resolved against the page', () => {
    const html = page(a('sidebar-episode-item', '/some-show-episode-2-two') + a('sidebar-episode-item', '/some-show-episode-1-one') + a('sidebar-episode-item', '/some-show-episode-1-one') + a('other', '/nope'));
    expect(parseEpisodeLinks(html, U)).toEqual(['https://www.wcostream.tv/some-show-episode-2-two', 'https://www.wcostream.tv/some-show-episode-1-one']);
    expect(parseEpisodeLinks(page(a('dark-episode-item', '/x-episode-1-y')), U)).toHaveLength(1);
    expect(parseEpisodeLinks(page('<p>nothing</p>'), U)).toEqual([]);
  });

  it('keeps the requested language when a page lists both', () => {
    const html = page(a('sonra', '/s-episode-1-dubbed', 'dub') + a('sonra', '/s-episode-1-subbed', 'sub') + a('sonra', '/s-episode-2-dubbed', 'dub'));
    expect(parseEpisodeLinks(html, U, 'dub')).toHaveLength(2);
    expect(parseEpisodeLinks(html, U, 'sub')).toHaveLength(1);
  });

  it('numbers seasons the way the downloader does: no "season" in the link means season 1', () => {
    const l = buildListing([
      'https://www.wcostream.tv/show-episode-1-a', 'https://www.wcostream.tv/show-episode-2-b',
      'https://www.wcostream.tv/show-season-2-episode-1-c', 'https://www.wcostream.tv/show-season-2-episode-3-d']);
    expect(isListed(l, { s: 1, e: 2 }, false)).toBe(true);
    expect(isListed(l, { s: 1, e: 3 }, false)).toBe(false);
    expect(isListed(l, { s: 2, e: 3 }, false)).toBe(true);
    expect(isListed(l, { s: 2, e: 2 }, false)).toBe(false);
    expect(isListed(l, { s: 3, e: 1 }, false)).toBe(false);
    expect(l.latest).toEqual({ s: 2, e: 3 });
    expect(latestText(l)).toBe('2x03');
  });

  it('looks absolute shows up by their overall number', () => {
    const l = buildListing(['https://www.wcostream.tv/anime-episode-1-a', 'https://www.wcostream.tv/anime-episode-24-b']);
    expect(isListed(l, { s: 2, e: 1, abs: 24 }, true)).toBe(true);
    expect(isListed(l, { s: 2, e: 2, abs: 25 }, true)).toBe(false);
    expect(isListed(l, { s: 2, e: 2 }, true)).toBe(false);
    expect(latestText(l)).toBe('episode 24');
  });

  it('reads the title out of a link and ignores placeholder titles', () => {
    expect(linkTitle('https://www.wcostream.tv/catdog-episode-23-siege-on-fort-catdog')).toBe('siegeonfortcatdog');
    expect(linkTitle('https://www.wcostream.tv/show-season-2-episode-3-the-big-one-english-dubbed')).toBe('thebigone');
    expect(linkTitle('https://www.wcostream.tv/naruto-episode-5-english-dubbed')).toBe('');
    expect(linkTitle('https://www.wcostream.tv/black-butler-episode-3-english-dubbed-2')).toBe('');
    expect(realTitle('Episode 5')).toBe('');
    expect(realTitle('TBA')).toBe('');
    expect(realTitle('Siege on Fort CatDog!')).toBe('siegeonfortcatdog');
  });

  const W = 'https://www.wcostream.tv/';
  it('finds a two-segment link by its titles and never trusts the number on such a show', () => {
    // The site: episode 1 = segments A+B, episode 2 = segments C+D. Sonarr numbers the four segments 1 to 4.
    const l = buildListing([W + 'paw-episode-1-pups-make-a-splash-pups-fall-festival', W + 'paw-episode-2-pups-save-the-sea-turtles-pup-and-the-very-big-baby']);
    const eps = ['Pups Make a Splash', 'Pups Fall Festival', 'Pups Save the Sea Turtles', 'Pup and the Very Big Baby', 'Pups and the Kitty-tastrophe']
      .map((t, i) => ({ id: 10 + i, s: 1, e: i + 1, t }));
    const src = resolveSources(l, eps, false);
    expect(src.get(10)).toEqual({ kind: 'title', url: W + 'paw-episode-1-pups-make-a-splash-pups-fall-festival', ids: [10, 11], partial: undefined });
    expect(src.get(11)).toMatchObject({ kind: 'title', ids: [10, 11] });   // 1x02 is in the site's episode 1, not its episode 2
    expect(src.get(12)).toMatchObject({ kind: 'title', ids: [12, 13] });
    expect(src.get(14)).toEqual({ kind: 'none', why: 'unlisted' });
  });

  it('refuses a number whose link is a different episode, and allows one whose title agrees or cannot be compared', () => {
    const l = buildListing([W + 'show-episode-1-something-else-entirely', W + 'show-episode-2-the-seccond-one', W + 'show-episode-3-english-dubbed']);
    const eps = [{ id: 1, s: 1, e: 1, t: 'The First One' }, { id: 2, s: 1, e: 2, t: 'The Second One' }, { id: 3, s: 1, e: 3, t: 'The Third One' }, { id: 4, s: 1, e: 4, t: 'TBA' }];
    const src = resolveSources(l, eps, false);
    expect(src.get(1)).toEqual({ kind: 'none', why: 'different', got: 'somethingelseentirely' });
    expect(src.get(2)).toMatchObject({ kind: 'title', ids: [2] });          // a typo on the site is still the episode
    expect(src.get(3)).toEqual({ kind: 'number' });                         // the link has no title: nothing to compare
    expect(src.get(4)).toEqual({ kind: 'none', why: 'unlisted' });
  });

  it('anime with no titles in its links stays on numbers, by season or straight through', () => {
    const l = buildListing([1, 2, 3].map((n) => W + `anime-episode-${n}-english-dubbed`));
    const eps = [{ id: 1, s: 1, e: 1, abs: 1, t: 'A' }, { id: 2, s: 1, e: 2, abs: 2, t: 'B' }, { id: 3, s: 2, e: 1, abs: 3, t: 'C' }];
    expect(resolveSources(l, eps, false).get(3)).toEqual({ kind: 'none', why: 'unlisted' });
    expect(resolveSources(l, eps, true).get(3)).toEqual({ kind: 'number' });
    const fit = numberingFit(l, eps, new Set([2, 3]), false);
    expect(fit).toMatchObject({ work: 2, season: 1, absolute: 2, byTitle: 0, unlisted: 1, different: 0, flat: true, wco: '3 episodes, numbered 1 to 3' });
  });

  it('a link that names the episode plus something Sonarr calls differently still holds the episode', () => {
    const l = buildListing([W + 'show-episode-7-the-long-goodbye-bonus-short']);
    const src = resolveSources(l, [{ id: 1, s: 1, e: 3, t: 'The Long Goodbye' }], false);
    expect(src.get(1)).toMatchObject({ kind: 'title', ids: [1], partial: true });
  });

  it('a title that reads two ways is not used', () => {
    const l = buildListing([W + 'show-episode-1-pilot']);
    const eps = [{ id: 1, s: 1, e: 1, t: 'Pilot' }, { id: 2, s: 2, e: 1, t: 'Pilot' }];
    expect(resolveSources(l, eps, false).get(1)).toEqual({ kind: 'number' });   // falls back to the number, where the titles agree
    expect(resolveSources(l, eps, false).get(2)).toEqual({ kind: 'none', why: 'unlisted' });
  });

  it('reads the title in a downloaded file name and compares it with the episode', () => {
    expect(fileTitle('Molly Of Denali-S01E02-Cabbagezilla Name Game.mp4')).toBe('cabbagezillanamegame');
    expect(fileTitle('Show-S01E05-English Dubbed.mp4')).toBe('');
    expect(fileIsEpisode('Molly Of Denali-S01E02-Cabbagezilla Name Game.mp4', 'Have Canoe, Will Paddle')).toBe(false);
    expect(fileIsEpisode('Teen Titans Go-S02E03-Pirates.mp4', 'Pirates')).toBe(true);
    expect(fileIsEpisode('Anime-S01E05-English Dubbed.mp4', 'Anything')).toBe(true);
    expect(alike('thesecondone', 'theseccondone')).toBeGreaterThan(0.9);
  });

  it('a title two links share is not used', () => {
    const l = buildListing(['https://www.wcostream.tv/s-episode-1-pilot', 'https://www.wcostream.tv/s-season-2-episode-1-pilot']);
    expect(l.byTitle.has('pilot')).toBe(false);
  });

  it('an empty page lists nothing', () => {
    const l = buildListing([]);
    expect(l.count).toBe(0);
    expect(isListed(l, { s: 1, e: 1 }, false)).toBe(false);
    expect(latestText(l)).toBe('');
  });
});

describe('which episode a pasted link is (18 Nov 2026)', () => {
  const eps = [
    { id: 1, s: 1, e: 1, abs: 1, t: 'Pups Make a Splash' }, { id: 2, s: 1, e: 2, abs: 2, t: 'Pups Fall Festival' },
    { id: 3, s: 1, e: 3, abs: 3, t: 'Pups Save a Train' }, { id: 4, s: 2, e: 1, abs: 4, t: '' },
  ];
  it('picks both episodes a two-story link holds, by title', () => {
    const l = buildListing(['https://www.wcostream.tv/paw-patrol-episode-1-pups-make-a-splash-pups-fall-festival-english-dubbed']);
    const src = resolveSources(l, eps, false);
    expect(pickedBy('https://www.wcostream.tv/paw-patrol-episode-1-pups-make-a-splash-pups-fall-festival-english-dubbed', eps, src, false)).toEqual([1, 2]);
  });
  it('picks by season and number when there is no title to go on', () => {
    const l = buildListing(['https://www.wcostream.tv/show-season-2-episode-1-english-dubbed']);
    const src = resolveSources(l, eps, false);
    expect(pickedBy('http://www.wcostream.tv/show-season-2-episode-1-english-dubbed/', eps, src, false)).toEqual([4]);
  });
  it('picks nothing when the number points at a different episode', () => {
    const l = buildListing(['https://www.wcostream.tv/show-episode-3-a-totally-different-story-english-dubbed']);
    const src = resolveSources(l, eps, false);
    expect(pickedBy('https://www.wcostream.tv/show-episode-3-a-totally-different-story-english-dubbed', eps, src, false)).toEqual([]);
  });
});

describe('reading a show page again (18 Nov 2026)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { WcoEpisodesService } = require('./wco-episodes.service');
  const page = (n: number) => Array.from({ length: n }, (_, i) => `<a class="sonra" href="https://www.wcostream.tv/overgeared-episode-${i + 1}-english-dubbed">Overgeared Episode ${i + 1} English Dubbed</a>`).join('');
  it('keeps a copy for six hours, but fresh reads the page again and finds the new episode', async () => {
    let n = 7, reads = 0;
    const app = { fetchPageHtml: async () => { reads++; return `<div id="sidebar_right3">${page(n)}</div>`; } };
    const svc = new WcoEpisodesService(app as any);
    const first = await svc.listing('overgeared', 'dub');
    n = 8;
    const kept = await svc.listing('overgeared', 'dub');
    const again = await svc.listing('overgeared', 'dub', true);
    expect([first?.count, kept?.count, again?.count, reads]).toEqual([7, 7, 8, 2]);
    expect(svc.ownerOf('https://www.wcostream.tv/overgeared-episode-8-english-dubbed/')).toBe('overgeared');
    expect(svc.ownerOf('https://www.wcostream.tv/something-else-episode-1-english-dubbed')).toBeUndefined();
  });
});

describe('is the link this show at all (18 Nov 2026)', () => {
  const W = 'https://www.wcostream.tv/';
  const mine = ['Pups Make a Splash', 'Pups Fall Festival', 'Pups Save the Sea Turtles', 'Pup and the Very Big Baby', 'Pups and the Kitty-tastrophe', 'Pups Save a Train']
    .map((t, i) => ({ id: i + 1, s: 1, e: i + 1, t }));
  const titled = (titles: string[]) => buildListing(titles.map((t, i) => `${W}some-show-episode-${i + 1}-${t.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-english-dubbed`));

  it('another show\'s titles: wrong, whatever the names say', () => {
    const other = titled(['A Gift for Aqua', 'An Explosion', 'Panties for the Hero', 'The Cabbage Harvest', 'A Rival Appears', 'The Lake Purge']);
    expect(linkCheck(other, mine, true)).toMatchObject({ ok: false, compared: 6, matched: 0, why: 'none of 6 episode titles on wcostream are this show\'s in Sonarr' });
  });
  it('its own titles, even a few and spelt differently: right', () => {
    const same = titled(['Pups Make a Splash', 'Pups Fall Festival', 'Pups Save the Sea Turtle', 'Something Else', 'Another', 'Third']);
    expect(linkCheck(same, mine, false)).toMatchObject({ ok: true });
  });
  it('no titles to compare: the names decide; an empty list says nothing', () => {
    const bare = buildListing([1, 2, 3, 4, 5, 6].map((n) => `${W}konosuba-episode-${n}-english-dubbed`));
    expect(linkCheck(bare, mine, false)).toMatchObject({ ok: false, why: expect.stringMatching(/name on wcostream is not one of the show's names/) });
    expect(linkCheck(bare, mine, true).ok).toBe(true);
    expect(linkCheck(buildListing([]), mine, false).ok).toBe(true);
  });
});

describe("the site's duplicate marker is not a title (21 Nov 2026)", () => {
  it('reads no title from "-english-dubbed-2-2" or a bare number, and keeps a real one', () => {
    expect(linkTitle('https://www.wcostream.tv/one-piece-episode-195-english-dubbed-2-2')).toBe('');
    expect(linkTitle('https://www.wcostream.tv/one-piece-episode-195-english-dubbed-2')).toBe('');
    expect(linkTitle('https://www.wcostream.tv/some-show-episode-3-2')).toBe('');
    expect(linkTitle('https://www.wcostream.tv/catdog-episode-23-siege-on-fort-catdog-english-dubbed-2')).toBe('siegeonfortcatdog');
  });
});

describe("a season link over a page with seasons of its own (22 Nov 2026: Stardust Crusaders)", () => {
  it('runs the page\'s seasons on, and gives each episode its own page', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { runOnSources } = require('./wco-episodes.util');
    const W = 'https://www.wcostream.tv/';
    const l = buildListing([
      ...[1, 2, 24].map((n) => `${W}jojo-stardust-crusaders-episode-${n}-english-dubbed`),
      ...[1, 5, 24].map((n) => `${W}jojo-stardust-crusaders-season-2-episode-${n}-english-dubbed`)]);
    const map = [1, 24, 25, 29, 48, 30].map((e) => ({ id: 100 + e, s: 2, e, abs: e }));
    const src = runOnSources(l, map);
    expect(src.get(101)).toMatchObject({ kind: 'title', url: `${W}jojo-stardust-crusaders-episode-1-english-dubbed` });
    expect(src.get(124)).toMatchObject({ kind: 'title', url: `${W}jojo-stardust-crusaders-episode-24-english-dubbed` });
    expect(src.get(125)).toMatchObject({ kind: 'title', url: `${W}jojo-stardust-crusaders-season-2-episode-1-english-dubbed` });
    expect(src.get(129)).toMatchObject({ kind: 'title', url: `${W}jojo-stardust-crusaders-season-2-episode-5-english-dubbed` });
    expect(src.get(148)).toMatchObject({ kind: 'title', url: `${W}jojo-stardust-crusaders-season-2-episode-24-english-dubbed` });
    expect(src.get(130)).toEqual({ kind: 'none', why: 'unlisted' });          // 2x06 on the site is not listed
  });
});

// 23 Nov 2026: 57 followed shows had "0 on wcostream" for four different reasons; each now says which.
describe('why the rest is not on wcostream', () => {
  const W = 'https://www.wcostream.tv/';
  const ep = (s: number, e: number, abs?: number) => ({ id: s * 100 + e, s, e, abs });
  const flat = (slug: string, n: number) => buildListing(Array.from({ length: n }, (_, i) => `${W}${slug}-episode-${i + 1}-english-dubbed`));

  it('nothing to say when nothing is left', () => {
    expect(gapReason(flat('kaiji', 26), [], false)).toBeUndefined();
  });
  it('a page that lists nothing: the link is dead (Beyblade X)', () => {
    expect(gapReason(buildListing([]), [ep(1, 27), ep(1, 28)], false)).toEqual({ why: 'empty', left: 2 });
  });
  it('long videos with no episode numbers: not fillable here (Clone Wars 2003)', () => {
    const vols = buildListing([1, 2, 3, 4, 5].map((n) => `${W}star-wars-clone-wars-volume-${n}-english-dubbed`));
    expect(gapReason(vols, [ep(1, 1), ep(3, 5)], false)).toEqual({ why: 'packaged', left: 2 });
  });
  it('seasons the page has none of (Kaiji season 2, Digimon Fusion season 3)', () => {
    expect(gapReason(flat('kaiji', 26), [ep(2, 1), ep(2, 26)], false)).toEqual({ why: 'seasons', left: 2, seasons: [2] });
    const mixed = gapReason(flat('kaiji', 26), [ep(1, 27), ep(2, 1)], false);
    expect(mixed).toMatchObject({ why: 'stops', seasons: [2] });             // a season missing among other gaps is still named
  });
  it('episodes after the last one listed', () => {
    expect(gapReason(flat('beyblade-x', 26), [ep(1, 27), ep(1, 40)], false)).toEqual({ why: 'stops', left: 2, stops: 'episode 26' });
    expect(gapReason(flat('one-piece', 1100), [ep(21, 5, 1105)], true)).toEqual({ why: 'stops', left: 1, stops: 'episode 1100' });
  });
  it('listed under the number but another episode', () => {
    expect(gapReason(flat('x', 5), [{ ...ep(1, 2), different: true }], false)).toEqual({ why: 'different', left: 1 });
    expect(gapReason(flat('x', 5), [ep(1, 2)], false)).toEqual({ why: 'unlisted', left: 1 });
  });
});
