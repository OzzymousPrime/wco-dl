import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import Lifter as lifter_module  # noqa: E402
from bs4 import BeautifulSoup  # noqa: E402

SHOW_URL = 'https://www.wcostream.tv/anime/some-show'
EPISODES = ['https://www.wcostream.tv/some-show-episode-{0}-english-dubbed'.format(n) for n in (3, 2, 1)]
SHOW_PAGE = ''.join('<a class="dark-episode-item" href="{0}">ep</a>'.format(url) for url in EPISODES)
PREMIUM_PAGE = '<p>This video is for the WCO Premium users only.</p>'
EPISODE_PAGE = '<iframe id="frameNewcizgifilmuploads0" src="https://embed.wcostream.com/inc/embed/x.php"></iframe>'


class FakeResponse(object):
    status_code = 200
    url = SHOW_URL
    content = SHOW_PAGE.encode('utf-8')


def run_show(premium=(), failing=()):
    """Run Lifter on a three-episode show; returns (lifter, exit code, stdout)."""

    def fake_episode_page(self, url):
        return BeautifulSoup(PREMIUM_PAGE if url in premium else EPISODE_PAGE, 'html.parser')

    def fake_downloader(**kwargs):
        return mock.Mock(failed=kwargs['hidden_url'].endswith(tuple(failing)))

    created = []
    original_init = lifter_module.Lifter.__init__

    def capture_init(self, *args, **kwargs):
        created.append(self)
        original_init(self, *args, **kwargs)

    stdout = io.StringIO()
    exit_code = 0
    with tempfile.TemporaryDirectory() as output, \
            mock.patch.object(lifter_module.Lifter, '__init__', capture_init), \
            mock.patch.object(lifter_module.Lifter, 'request_c', return_value=FakeResponse()), \
            mock.patch.object(lifter_module.Lifter, 'get_episode_page', fake_episode_page), \
            mock.patch.object(lifter_module.Lifter, 'find_hidden_url', lambda self, url, soup=None: url + '#embed'), \
            mock.patch.object(lifter_module.Lifter, 'get_download_url',
                              return_value=([('720 (HD)', 'https://cdn.test/v.mp4')], 'https://cdn.test/b.mp4')), \
            mock.patch.object(lifter_module, 'Downloader', side_effect=fake_downloader), \
            redirect_stdout(stdout):
        try:
            lifter_module.Lifter(url=SHOW_URL, resolution='1080', logger='False', season='All', ep_range='All',
                                 exclude=None, output=output, newest=False, settings=mock.Mock(),
                                 database=mock.Mock(), quiet='True', threads=None)
        except SystemExit as e:
            exit_code = e.code
    return created[0], exit_code, stdout.getvalue()


class PremiumSkipTest(unittest.TestCase):

    def test_premium_only_episodes_do_not_fail_the_show(self):
        lifter, exit_code, output = run_show(premium=[EPISODES[0]])

        self.assertEqual(exit_code, 0)
        self.assertEqual(lifter.download_errors, 0)
        self.assertEqual(lifter.skipped_premium, 1)
        self.assertEqual(lifter.downloaded, 2)
        self.assertIn('2 episode(s) downloaded, 1 premium-only skipped', output)
        self.assertIn('Skipping {0}, it is only available to WCO Premium users'.format(EPISODES[0]), output)

    def test_show_with_only_premium_episodes_exits_0(self):
        lifter, exit_code, output = run_show(premium=EPISODES)

        self.assertEqual(exit_code, 0)
        self.assertEqual(lifter.skipped_premium, 3)
        self.assertIn('0 episode(s) downloaded, 3 premium-only skipped', output)

    def test_download_errors_still_exit_1(self):
        lifter, exit_code, output = run_show(premium=[EPISODES[0]], failing=['episode-1-english-dubbed#embed'])

        self.assertEqual(exit_code, 1)
        self.assertEqual(lifter.download_errors, 1)
        self.assertEqual(lifter.skipped_premium, 1)
        self.assertIn('1 episode(s) downloaded, 1 premium-only skipped', output)
        self.assertIn('1 episode(s) failed to download', output)

    def test_clean_show_reports_downloads(self):
        lifter, exit_code, output = run_show()

        self.assertEqual(exit_code, 0)
        self.assertIn('3 episode(s) downloaded, 0 premium-only skipped', output)


if __name__ == '__main__':
    unittest.main()


class InfoExtractorTest(unittest.TestCase):
    """18 Nov 2026: links that end in the episode number were misnamed (episode 10 as 1 plus "0", episode 9 as 0)."""

    def test_a_link_that_ends_in_the_number(self):
        get = lifter_module.Lifter.info_extractor
        self.assertEqual(get('https://www.wcostream.tv/happy-the-hoglet-episode-10')[1:4], ('Season 1', 'Episode 10', ''))
        self.assertEqual(get('https://www.wcostream.tv/happy-the-hoglet-episode-9/')[1:4], ('Season 1', 'Episode 9', ''))
        self.assertEqual(get('https://www.wcostream.tv/some-show-season-2-episode-10')[1:4], ('Season 2', 'Episode 10', ''))

    def test_links_with_a_title_read_as_before(self):
        get = lifter_module.Lifter.info_extractor
        self.assertEqual(get('https://www.wcostream.tv/happy-the-hoglet-episode-10-happy-butterfly')[:4],
                         ('Happy The Hoglet', 'Season 1', 'Episode 10', 'Happy Butterfly'))
        self.assertEqual(get('https://www.wcostream.tv/some-show-season-2-episode-5-english-dubbed')[:4],
                         ('Some Show', 'Season 2', 'Episode 5', 'English Dubbed'))


class AlternateUrlsTest(unittest.TestCase):
    """18 Nov 2026: a refused video is tried at the other qualities and on the CDN before the episode fails."""

    def test_every_other_copy_once_best_first(self):
        sources = [('480 (SD)', 'https://s1.example/getvid?evid=SD'), ('720 (HD)', 'https://s1.example/getvid?evid=HD')]
        got = lifter_module.Lifter.alternate_urls(sources, 'https://s1.example/getvid?evid=HD', 'https://cdn.example/getvid?evid=SD')
        self.assertEqual(got, ['https://s1.example/getvid?evid=SD', 'https://cdn.example/getvid?evid=SD', 'https://cdn.example/getvid?evid=HD'])

    def test_a_backup_on_the_same_server_is_not_tried_twice(self):
        sources = [('480 (SD)', 'https://s1.example/getvid?evid=SD')]
        got = lifter_module.Lifter.alternate_urls(sources, 'https://s1.example/getvid?evid=SD', 'https://s1.example/getvid?evid=SD')
        self.assertEqual(got, [])
