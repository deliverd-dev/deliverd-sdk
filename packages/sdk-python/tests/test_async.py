"""The async client: that it mirrors the sync one, and that it is really async.

Two properties, and the second is the one worth the file. `aio.py` is generated,
so the interesting failure is not a typo — it is the generated file drifting
from the generator after somebody edits one by hand, or a method quietly coming
back synchronous and blocking the caller's event loop.
"""

import asyncio
import inspect
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from deliverd import Deliverd  # noqa: E402
from deliverd.aio import AsyncDeliverd  # noqa: E402
from deliverd.dev import DevelopmentOptions  # noqa: E402

import gen_async  # noqa: E402

QUIET = DevelopmentOptions(log=False, delay=0.0)


def client() -> AsyncDeliverd:
    return AsyncDeliverd(mode="development", development=QUIET)


class Generated(unittest.TestCase):
    def test_the_committed_file_is_what_the_generator_produces(self):
        """Otherwise the generator is decoration and the file is hand-written.

        The whole reason `aio.py` is generated is that sixty delegating methods
        written by hand are sixty chances to mistype a default. That only holds
        while the committed file is the output — a single hand-edit and the
        script becomes a comment.
        """
        committed = open(
            os.path.join(os.path.dirname(__file__), "..", "src", "deliverd", "aio.py"),
            encoding="utf-8",
        ).read()
        self.assertEqual(
            committed,
            gen_async.render(),
            "src/deliverd/aio.py is not what scripts/gen_async.py produces. Regenerate it: "
            "PYTHONPATH=src python3 scripts/gen_async.py > src/deliverd/aio.py",
        )


class Mirrors(unittest.TestCase):
    def test_every_namespace_and_method_has_an_async_twin(self):
        sync, aio = Deliverd(mode="development", development=QUIET), client()
        namespaces = [n for n in vars(sync) if not n.startswith("_") and n != "http"]
        self.assertGreater(len(namespaces), 6)
        for name in namespaces:
            self.assertTrue(hasattr(aio, name), "AsyncDeliverd has no {}".format(name))
            if name in ("webhooks", "development"):
                continue  # pure, and deliberately not wrapped
            for method in dir(getattr(sync, name)):
                if method.startswith("_"):
                    continue
                self.assertTrue(
                    hasattr(getattr(aio, name), method),
                    "deliverd.{0}.{1} has no async twin".format(name, method),
                )

    def test_the_methods_that_wait_are_coroutines(self):
        """The failure this catches is silent and expensive.

        A method that comes back synchronous still works — it just blocks the
        event loop for as long as the request takes, which for `wait()` is
        minutes. The first version of the generator decided `wait()` was pure
        because it does not name the transport itself; it is a poll loop.
        """
        for holder, method in [
            (client().approvals, "create"),
            (client().approvals, "get"),
            (client().reports, "publish"),
            (client().flows, "resume"),
            (client(), "approve"),
            (client(), "collect"),
        ]:
            self.assertTrue(
                inspect.iscoroutinefunction(getattr(holder, method)),
                "{} is not a coroutine, so awaiting it does not yield".format(method),
            )

    def test_a_handle_that_comes_back_is_an_async_handle(self):
        async def go():
            c = client()
            approval = await c.approvals.create(title="x")
            # The trap: a sync handle here means `.wait()` blocks the loop.
            self.assertTrue(inspect.iscoroutinefunction(approval.wait))
            settled = await approval.wait()
            self.assertTrue(inspect.iscoroutinefunction(settled.refresh))
            flow = await c.flows.resume(title="t", external_id="e")
            self.assertTrue(inspect.iscoroutinefunction(flow.approve))

        asyncio.run(go())

    def test_the_pure_conversions_are_not_coroutines(self):
        async def go():
            settled = await (await client().approvals.create(title="x")).wait()
            self.assertFalse(inspect.iscoroutinefunction(settled.to_decision))
            self.assertTrue(settled.to_decision().approved)

        asyncio.run(go())


class ReallyConcurrent(unittest.TestCase):
    def test_six_asks_wait_together_rather_than_in_turn(self):
        """What the module is for.

        Each call holds a worker thread, which is the documented cost — but the
        caller's six approvals overlap instead of queueing, and that is the
        whole reason to have this rather than telling people to use
        `asyncio.to_thread` themselves.
        """
        slow = AsyncDeliverd(
            mode="development", development=DevelopmentOptions(log=False, delay=0.3)
        )

        async def go():
            started = time.monotonic()
            outcomes = await asyncio.gather(*[slow.approve(title="ask") for _ in range(6)])
            return time.monotonic() - started, outcomes

        took, outcomes = asyncio.run(go())
        self.assertTrue(all(o.approved for o in outcomes))
        self.assertLess(
            took, 0.3 * 6 * 0.5, "six 0.3s asks took {:.2f}s — they ran in turn".format(took)
        )
