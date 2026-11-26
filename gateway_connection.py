"""Prepare one unused TLS connection; never retry an ambiguously submitted request.

Inspired by the preconnection proposal in meet-copilot PR #1 (irisrumtub).
No API request or credentials are sent while warming the connection.
"""
import http.client
import threading
import time


class WarmConnection:
    def __init__(self, host, *, factory=None, clock=time.monotonic):
        self.host = host
        self.factory = factory or http.client.HTTPSConnection
        self.clock = clock
        self.lock = threading.Lock()
        self.spare = None
        self.opened = 0.0
        self.worker = None
        self.generation = 0
        self.stopped = False

    def keep(self):
        with self.lock:
            if self.stopped or self.spare is not None or self.worker is not None:
                return
            generation = self.generation
            self.worker = threading.Thread(target=self._prepare, args=(generation,), daemon=True)
            self.worker.start()

    def _prepare(self, generation):
        connection = None
        try:
            connection = self.factory(self.host, timeout=15)
            connection.connect()
            with self.lock:
                if not self.stopped and generation == self.generation and self.spare is None:
                    self.spare, self.opened = connection, self.clock()
                    connection = None
        except (OSError, http.client.HTTPException):
            pass
        finally:
            if connection is not None:
                connection.close()
            with self.lock:
                self.worker = None

    def take(self):
        with self.lock:
            connection, opened = self.spare, self.opened
            self.spare = None
        if connection is not None and self.clock() - opened > 30:
            connection.close()
            connection = None
        # Prepare the following hint in parallel; there is no idle refresh loop.
        self.keep()
        return connection

    def close(self):
        with self.lock:
            self.stopped = True
            self.generation += 1
            connection, self.spare = self.spare, None
        if connection is not None:
            connection.close()
