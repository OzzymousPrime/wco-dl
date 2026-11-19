import {
  dubVerdict,
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
