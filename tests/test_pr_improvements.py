import http.client
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import hints
from context_index import ContextIndex
from gateway_connection import WarmConnection


class Connection:
    def __init__(self, *a, **kw):
        self.closed = False
        self.sock = None
        self.requests = 0
    def connect(self): pass
    def close(self): self.closed = True
    def request(self, *a, **kw): self.requests += 1
    def getresponse(self): raise http.client.RemoteDisconnected('closed after POST')


class Improvements(unittest.TestCase):
    def test_russian_endings_and_ignored_formats(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, 'plan.md').write_text('# Тарифные планы\n\nВымышленный базовый тариф включает три объекта.', encoding='utf-8')
            Path(root, 'ignored.pdf').write_bytes(b'placeholder')
            index = ContextIndex(root, config={})
            self.assertIn('базовый тариф', index.search('Какие тарифы?')['results'][0]['passage']['text'])
            self.assertEqual(index.metadata['skipped'], ['ignored.pdf'])

    def test_spare_is_taken_once_and_stale_is_closed(self):
        pool = WarmConnection('example.invalid', factory=Connection, clock=lambda: 100)
        spare = Connection()
        pool.spare, pool.opened = spare, 99
        with patch.object(pool, 'keep'):
            self.assertIs(pool.take(), spare)
            self.assertIsNone(pool.take())
            pool.spare, pool.opened = spare, 1
            self.assertIsNone(pool.take())
        self.assertTrue(spare.closed)

    def test_failed_connect_is_closed(self):
        connection = Connection()
        connection.connect = lambda: (_ for _ in ()).throw(OSError('offline'))
        pool = WarmConnection('example.invalid', factory=lambda *a, **kw: connection)
        pool.keep()
        worker = pool.worker
        if worker: worker.join(2)
        self.assertTrue(connection.closed)
        self.assertIsNone(pool.spare)

    def test_shutdown_during_connect_cannot_publish_spare(self):
        entered, release = threading.Event(), threading.Event()
        connection = Connection()
        def connect():
            entered.set()
            release.wait(2)
        connection.connect = connect
        pool = WarmConnection('example.invalid', factory=lambda *a, **kw: connection)
        pool.keep()
        worker = pool.worker
        self.assertTrue(entered.wait(1))
        pool.close(); release.set(); worker.join(2)
        self.assertTrue(connection.closed)
        self.assertIsNone(pool.spare)

    def test_no_replay_after_ambiguous_post_failure(self):
        connection = Connection()
        with patch.object(hints.WARM, 'take', return_value=connection), patch('hints.http.client.HTTPSConnection') as factory:
            with self.assertRaises(hints.HintError):
                hints.gateway_stream('Rules', 'fictional-placeholder', 'What next?', [], False,
                                     hints.HintJob(), lambda *a: None)
            factory.assert_not_called()
        self.assertEqual(connection.requests, 1)
        self.assertTrue(connection.closed)
