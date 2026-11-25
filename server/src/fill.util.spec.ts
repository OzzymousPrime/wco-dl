import {
  alternatives,
  matchCatalogue,
  newlySeen,
  noteSeen,
  seasonNamed,
  namedAs,
  titleWords,
  dubVerdict,
  indexCatalogue,
  fileEpisode,
  fileMatches,
  matchSeries,
  normaliseTitle,
  parsePremium,
  parseProgress,
  parseShowLink,
  playVerdict,
} from './fill.util';
import { judgeDisk } from './disk-space';

describe('parseShowLink', () => {
  it('reads slug and language from a show link', () => {
    expect(parseShowLink('https://www.wcostream.tv/anime/re-zero-starting-life-in-another-world/?season=all&lang=dub')).toEqual({
      slug: 're-zero-starting-life-in-another-world',
      language: 'dub',
    });
  });
  it('takes a bare slug', () => {
    expect(parseShowLink('one-piece')).toEqual({ slug: 'one-piece' });
  });
  it("reads an episode's own link as its show, with the episode to pick (18 Nov 2026)", () => {
    expect(parseShowLink('https://www.wcostream.tv/overgeared-episode-8-english-dubbed')).toEqual({
      slug: 'overgeared', language: 'dub',
      episode: { link: 'https://www.wcostream.tv/overgeared-episode-8-english-dubbed', season: undefined, number: 8 },
    });
    expect(parseShowLink('https://www.wcostream.tv/my-show-season-2-episode-5-english-subbed')).toEqual({
      slug: 'my-show', language: 'sub',
      episode: { link: 'https://www.wcostream.tv/my-show-season-2-episode-5-english-subbed', season: 2, number: 5 },
    });
    expect(parseShowLink('overgeared-episode-8-english-dubbed').slug).toBe('overgeared');
  });
  it('leaves show links and show names with "episode" in them alone', () => {
    expect(parseShowLink('https://www.wcostream.tv/anime/the-final-episode-1').episode).toBeUndefined();
    expect(parseShowLink('the-final-episode-1')).toEqual({ slug: 'the-final-episode-1' });
  });
  it('rejects other sites and junk', () => {
    expect(() => parseShowLink('https://example.com/anime/x')).toThrow();
    expect(() => parseShowLink('')).toThrow();
    expect(() => parseShowLink('https://www.wcostream.tv/')).toThrow();
  });
});

describe('matchSeries', () => {
  const series = [
    { id: 575, title: 'Re: ZERO, Starting Life in Another World', year: 2016, titleSlug: 're-zero-starting-life-in-another-world' },
    { id: 4039, title: 'One Piece', year: 1999, titleSlug: 'one-piece' },
    { id: 9, title: 'ONE PIECE (2023)', year: 2023, titleSlug: 'one-piece-2023' },
    { id: 7, title: 'Mystery Diners', year: 2013 },
  ];
  it('finds exact title matches, year ignored', () => {
    expect(matchSeries('re-zero-starting-life-in-another-world', series).map((s) => s.id)).toEqual([575]);
    expect(matchSeries('mystery-diners', series).map((s) => s.id)).toEqual([7]);
  });
  it('reads a percent-encoded link name (19 Nov 2026: Ranma ½ was flagged as another show)', () => {
    expect(matchSeries('ranma-%c2%bd-2024', [{ id: 1, title: 'Ranma ½ (2024)' }]).map((s) => s.id)).toEqual([1]);
    expect(matchSeries('bad-%zz-name', [{ id: 2, title: 'Bad Zz Name' }]).map((s) => s.id)).toEqual([2]);   // not decodable: read as written
  });
  it('matches a link that dropped the "&" (19 Nov 2026: Welsh & Shedar was flagged as another show)', () => {
    expect(matchSeries('welsh-shedar', [{ id: 3, title: 'Welsh & Shedar' }]).map((s) => s.id)).toEqual([3]);
    expect(matchSeries('welsh-and-shedar', [{ id: 3, title: 'Welsh & Shedar' }]).map((s) => s.id)).toEqual([3]);
  });
  it('returns every candidate when two shows share a name', () => {
    expect(matchSeries('one-piece', series).map((s) => s.id).sort()).toEqual([4039, 9]);
  });
  it('normalises titles', () => {
    expect(normaliseTitle('Re: ZERO (2016)')).toBe('rezero');
  });
});

describe('downloader output', () => {
  it('reads the latest tqdm percentage', () => {
    expect(parseProgress('Downloading:   7%|#  \rDownloading:  43%|####   ')).toBe(43);
    expect(parseProgress('nothing here')).toBeUndefined();
  });
  it('finds premium-only links', () => {
    const out = '[wco-dl] - Skipping https://www.wcostream.tv/one-piece-episode-8-english-dubbed-2-2, it is only available to WCO Premium users.';
    expect(parsePremium(out)).toEqual(['https://www.wcostream.tv/one-piece-episode-8-english-dubbed-2-2']);
  });
});

describe('file names', () => {
  it('reads S/E, season-episode and bare episode names', () => {
    expect(fileEpisode('Re Zero Starting Life In Another World-S02E14-English Dubbed.mp4')).toEqual({ season: 2, episode: 14 });
    expect(fileEpisode('Show Season 3 Episode 7.mp4')).toEqual({ season: 3, episode: 7 });
    expect(fileEpisode('Episode 1145 English Dubbed (720p).mp4')).toEqual({ episode: 1145 });
  });
  it('never reads a part two as the whole episode', () => {
    expect(fileEpisode('Episode 1145.5 English Dubbed (720p).mp4')).toBeUndefined();
  });
  it('matches the episode asked for', () => {
    expect(fileMatches('X-S02E14-English Dubbed.mp4', { season: 2, episode: 14 }, false)).toBe(true);
    expect(fileMatches('X-S02E15-English Dubbed.mp4', { season: 2, episode: 14 }, false)).toBe(false);
    expect(fileMatches('X-S03E14.mp4', { season: 2, episode: 14 }, false)).toBe(false);
    expect(fileMatches('One Piece-S01E1104-English Dubbed.mp4', { season: 21, episode: 12, absolute: 1104 }, true)).toBe(true);
    expect(fileMatches('One Piece-S01E1104.mp4', { season: 21, episode: 12, absolute: 1105 }, true)).toBe(false);
  });
});

describe('dubVerdict', () => {
  it('accepts an English track and refuses a tagged Japanese-only file', () => {
    expect(dubVerdict(['jpn', 'eng'], 'x.mkv').ok).toBe(true);
    expect(dubVerdict(['jpn'], 'x English Dubbed.mp4').ok).toBe(false);
  });
  it('trusts the name only when the audio is untagged', () => {
    expect(dubVerdict(['und'], 'x English Dubbed.mp4').ok).toBe(true);
    expect(dubVerdict(['und'], 'x English Subbed.mp4').ok).toBe(false);
  });
});

describe('playVerdict (17 Nov 2026)', () => {
  it('passes a file that opens, has video and runs near an episode', () => {
    expect(playVerdict({ read: true, video: true, seconds: 1420 }, 24).ok).toBe(true);
    expect(playVerdict({ read: true, video: true, seconds: 660 }, 22).ok).toBe(true);   // one segment of a paired episode
    expect(playVerdict(undefined, 24).ok).toBe(true);                                   // no ffprobe: never blocks
    expect(playVerdict({ read: true, video: true }, 24).ok).toBe(true);                 // length unknown
    expect(playVerdict({ read: true, video: true, seconds: 90 }, 2).ok).toBe(true);     // a shorts series
  });
  it('stops one that will not open, has no video, or is far too short', () => {
    expect(playVerdict({ read: false, video: false }, 24)).toMatchObject({ ok: false, why: expect.stringMatching(/would not open/) });
    expect(playVerdict({ read: true, video: false, seconds: 1400 }, 24)).toMatchObject({ ok: false, why: expect.stringMatching(/no video/) });
    expect(playVerdict({ read: true, video: true, seconds: 8 })).toMatchObject({ ok: false, why: 'The file runs only 8 seconds' });
    expect(playVerdict({ read: true, video: true, seconds: 300 }, 24)).toMatchObject({ ok: false, why: "The file runs 5 minutes; this show's episodes run about 24" });
  });
});

describe('judgeDisk', () => {
  it('is low only under a set limit, and never when the space is unknown', () => {
    expect(judgeDisk(12.37, 20)).toEqual({ freeGb: 12.3, minGb: 20, low: true });
    expect(judgeDisk(767, 20).low).toBe(false);
    expect(judgeDisk(undefined, 20).low).toBe(false);
    expect(judgeDisk(1, 0).low).toBe(false);
  });
});

describe('other wcostream pages for a series (23 Nov 2026)', () => {
  const items = [
    { name: 'Digimon Fusion', path: 'digimon-fusion', list: 'dubbed' as const },
    { name: 'Digimon Fusion Season 2', path: 'digimon-fusion-season-2', list: 'dubbed' as const },
    { name: 'Digimon Xros Wars: Hunters', path: 'digimon-xros-wars-hunters', list: 'subbed' as const },
    { name: 'Beyblade X English Dubbed', path: 'beyblade-x-english-dubbed-2', list: 'dubbed' as const },
  ];
  it('offers same-named and same-start pages, leaving out the ones already linked', () => {
    const got = alternatives({ title: 'Digimon Fusion', alternateTitles: [{ title: 'Digimon Xros Wars' }] } as any, indexCatalogue(items), items, new Set(['digimon-fusion']));
    expect(got.map((m) => m.slug)).toEqual(['digimon-fusion-season-2', 'digimon-xros-wars-hunters']);
    expect(alternatives({ title: 'Beyblade X' } as any, indexCatalogue(items), items, new Set(['beyblade-x-english-dubbed'])).map((m) => m.slug)).toEqual(['beyblade-x-english-dubbed-2']);
  });
});

// 25 Nov 2026: "Mao 2099" (Demon Lord 2099) lost its 2099 as a "year", so the wcostream show "mao" linked to it.
describe('names with numbers, and linking by itself', () => {
  it('drops a release year but keeps a number that is part of the name', () => {
    expect(normaliseTitle('DuckTales (2017)')).toBe('ducktales');
    expect(normaliseTitle('Mao 2099')).toBe('mao2099');
    expect(normaliseTitle('Blade Runner 2049')).toBe('bladerunner2049');
  });
  it('links by itself only on an exact name; a partial match is only offered', () => {
    const demon = { id: 5091, title: 'Demon Lord 2099', alternateTitles: [{ title: 'Mao 2099' }] };
    expect(matchSeries('mao', [demon])).toEqual([demon]);                    // offered as a start of its name...
    expect(namedAs('mao', demon)).toBe(false);                                // ...but not taken
    expect(namedAs('mao-2099', demon)).toBe(true);
    const pups = { id: 1, title: 'Paw Patrol: The Mighty Pups' };
    expect(matchSeries('paw-patrol', [pups])).toEqual([pups]);              // offered
    expect(namedAs('paw-patrol', pups)).toBe(false);                        // not taken
  });
});

// 26 Nov 2026: "magi" is the start of the letters of "magic knight rayearth", so Magi was linked to Rayearth.
describe('partial names match in whole words', () => {
  const magi = { id: 4662, title: 'Magi: The Labyrinth of Magic', alternateTitles: [{ title: 'Magi' }] };
  const pups = { id: 1, title: 'Paw Patrol: The Mighty Pups' };
  it('a name is not the start of another by its letters alone', () => {
    expect(matchSeries('magic-knight-rayearth-2026', [magi])).toEqual([]);
  });
  it('still offers a name that leads with the same words', () => {
    expect(matchSeries('paw-patrol', [pups])).toEqual([pups]);
    expect(matchSeries('magi-the-labyrinth-of-magic-season-2', [magi])).toEqual([magi]);
  });
  it('reads words the way names are compared', () => {
    expect(titleWords("Captain Thimble's Tugboat (2012)")).toEqual(['captain', 'thimbles', 'tugboat']);
    expect(titleWords('Mao 2099')).toEqual(['mao', '2099']);
  });
});

// 26 Nov 2026: wcostream's "Bleach: Thousand-Year Blood War" was linked to all of Bleach, so its episode 1 was 1x01.
describe('a wcostream show that is one season of a Sonarr series', () => {
  const bleach = { id: 1041, title: 'Bleach', titleSlug: 'bleach', seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 17 }],
    alternateTitles: [{ title: 'Bleach: Thousand-Year Blood War', sceneSeasonNumber: 17 }, { title: 'Bleach Sennen Kessen-hen', sceneSeasonNumber: 17 },
      { title: 'Bleach', seasonNumber: -1 }] };
  it('reads the season from the name Sonarr keeps for it', () => {
    expect(seasonNamed('bleach-thousand-year-blood-war', bleach)).toBe(17);
    expect(seasonNamed('bleach-sennen-kessen-hen-english-subbed', bleach)).toBe(17);
  });
  it("is the whole series under the series' own name, or a name for all of it", () => {
    expect(seasonNamed('bleach', bleach)).toBeUndefined();
    expect(seasonNamed('burichi', { ...bleach, alternateTitles: [{ title: 'Burichi', seasonNumber: -1 }] })).toBeUndefined();
    expect(seasonNamed('something-else', bleach)).toBeUndefined();
  });
  it('leaves a single-season series, a season Sonarr does not have, and a name for two seasons alone', () => {
    const one = { id: 1, title: 'Digimon Adventure: (2020)', seasons: [{ seasonNumber: 1 }], alternateTitles: [{ title: 'Digimon Adventure:', seasonNumber: 1 }] };
    expect(seasonNamed('digimon-adventure', one)).toBeUndefined();
    expect(seasonNamed('bleach-thousand-year-blood-war', { ...bleach, seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }] })).toBeUndefined();
    expect(seasonNamed('show-x', { id: 2, title: 'Show', seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
      alternateTitles: [{ title: 'Show X', sceneSeasonNumber: 1 }, { title: 'Show X', sceneSeasonNumber: 2 }] })).toBeUndefined();
  });
});

describe('a series is offered wcostream shows in whole words', () => {
  const items = [
    { name: 'Magic Knight Rayearth (2026)', path: 'magic-knight-rayearth-2026', list: 'dubbed' as const },
    { name: 'Kaijudo: Rise of the Duel Masters', path: 'kaijudo-rise-of-the-duel-masters', list: 'cartoon' as const },
    { name: 'Kaiju No. 8', path: 'kaiju-no-8', list: 'dubbed' as const },
    { name: 'Paw Patrol', path: 'paw-patrol', list: 'cartoon' as const },
  ];
  const index = indexCatalogue(items);
  it('"Kaiju" is offered "Kaiju No. 8", not "Kaijudo"; "Magic" is not "Magi"', () => {
    expect(matchCatalogue({ id: 1, title: 'Kaiju' }, index).candidates.map((c) => c.slug)).toEqual(['kaiju-no-8']);
    expect(matchCatalogue({ id: 3, title: 'Magic Knight' }, index).candidates.map((c) => c.slug)).toEqual(['magic-knight-rayearth-2026']);
    expect(matchCatalogue({ id: 4, title: 'Magical' }, index).candidates).toEqual([]);
  });
  it('still offers a show whose name starts another', () => {
    expect(matchCatalogue({ id: 2, title: 'Paw Patrol: The Mighty Pups' }, index)).toMatchObject({ kind: 'maybe', candidates: [{ slug: 'paw-patrol' }] });
  });
});

describe('new on wcostream (26 Nov 2026)', () => {
  const show = (path: string, list: 'dubbed' | 'cartoon' | 'subbed' = 'dubbed') => ({ name: path.replace(/-/g, ' '), path, list });
  it('takes the first read of a list as known, and tells what is added after', () => {
    const seen = { since: {}, shows: {} };
    expect(noteSeen(seen, [show('bleach'), show('mao')], '2026-11-26T01:00:00.000Z')).toEqual([]);
    expect(noteSeen(seen, [show('bleach'), show('mao'), show('new-one')], '2026-11-27T01:00:00.000Z').map((i) => i.path)).toEqual(['new-one']);
    expect(noteSeen(seen, [show('bleach'), show('mao'), show('new-one')], '2026-11-28T01:00:00.000Z')).toEqual([]);
    const rows = newlySeen(seen, [show('bleach'), show('mao'), show('new-one')], 30, Date.parse('2026-11-29T00:00:00Z'));
    expect(rows).toEqual([expect.objectContaining({ slug: 'new-one', language: 'dub', firstSeen: '2026-11-27T01:00:00.000Z' })]);
    expect(newlySeen(seen, [show('new-one')], 30, Date.parse('2027-02-01T00:00:00Z'))).toEqual([]);     // too long ago
  });
  it('a list read for the first time later starts there; a dub of a known sub is news', () => {
    const seen = { since: {}, shows: {} };
    noteSeen(seen, [show('mao', 'subbed')], '2026-11-26T01:00:00.000Z');
    expect(noteSeen(seen, [show('mao', 'subbed'), show('mao'), show('bleach')], '2026-11-27T01:00:00.000Z')).toEqual([]);     // the dubbed list's first read
    expect(noteSeen(seen, [show('mao', 'subbed'), show('mao'), show('bleach'), show('gintama')], '2026-11-28T01:00:00.000Z').map((i) => i.path)).toEqual(['gintama']);
  });
  it('a flood of unseen shows is the site renaming its pages, not news', () => {
    const seen = { since: {}, shows: {} };
    noteSeen(seen, [show('a-show')], '2026-11-26T01:00:00.000Z');
    const many = Array.from({ length: 200 }, (_, i) => show(`renamed-${i}`));
    expect(noteSeen(seen, many, '2026-11-27T01:00:00.000Z')).toEqual([]);
    expect(newlySeen(seen, many, 30, Date.parse('2026-11-28T00:00:00Z'))).toEqual([]);
  });
});
