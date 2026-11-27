import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

from chatgpt_client import ChatGPT
from server import atomic


class LoginCallbackTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.file = Path(temp.name) / 'account.dat'
        self.client = ChatGPT(self.file, atomic)

    def begin(self):
        url = self.client.begin('http://127.0.0.1:9123/auth/callback')
        return parse_qs(urlsplit(url).query)['state'][0]

    def test_restart_parallel_tabs_and_duplicate_redirect(self):
        first, second = self.begin(), self.begin()
        service = ChatGPT(self.file, atomic)
        self.assertTrue(service.public()['pending'])
        tokens = dict(id_token='test', access_token='test', token_type='bearer')
        with patch('chatgpt_client.json_request', return_value=tokens) as exchange:
            with patch.object(service, 'validate_identity', return_value={'sub':'user'}):
                params = dict(state=first, client_id='client', code='one')
                service.callback(params)
                service.callback(params)
                self.assertEqual(exchange.call_count, 1)
                service.callback(dict(params, state=second, code='two'))
                self.assertEqual(exchange.call_count, 2)
        self.assertFalse(service.public()['pending'])

    def test_invalid_and_incomplete_redirects(self):
        state = self.begin()
        for params in [{}, {'state':'wrong'}, {'state':state}]:
            with self.assertRaises(ValueError):
                self.client.callback(params)
        with patch('chatgpt_client.time.time', return_value=10**12):
            with self.assertRaisesRegex(ValueError, '10'):
                self.client.callback(dict(state=state, code='test'))
        self.assertFalse(self.client.public()['pending'])
