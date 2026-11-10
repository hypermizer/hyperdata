import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('runtime_watchdog', pathlib.Path(__file__).resolve().parents[1] / 'scripts/external-alert-watchdog.py')
watchdog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watchdog)
GOOD = {'healthy': True, 'streamFresh': True, 'fallbackFresh': True, 'deliveryBacklog': 0, 'core': {'healthy': True}}
DATA = dict(GOOD, healthy=False, core={'healthy': False, 'historyFresh': False, 'paperFresh': True, 'accountSyncFresh': True, 'markReferencesFresh': True})
DOWN = None


class RuntimeWatchdogTest(unittest.TestCase):
    def test_overnight_one_minute_flapping_never_notifies(self):
        state = {}; notices = []
        for minute in range(18 * 60):
            state, notice = watchdog.advance(state, DATA if minute % 4 == 0 else GOOD, 100000 + minute * 60)
            if notice: notices.append(notice)
        self.assertEqual(notices, [])

    def test_one_notice_for_persistent_issue_without_reminders(self):
        state = {}; notices = []
        for minute in range(18 * 60):
            state, notice = watchdog.advance(state, DATA, 100000 + minute * 60)
            if notice: notices.append(notice)
            state = json.loads(json.dumps(state))  # controller process restart
        self.assertEqual(len(notices), 1)
        self.assertIn('market history', notices[0]['message'])
        self.assertNotIn('Price alerts may be delayed', notices[0]['message'])

    def test_recovery_is_quiet_and_does_not_reset_daily_budget(self):
        state = {}; notices = []
        for minute in range(24 * 60):
            state, notice = watchdog.advance(state, DATA if minute % 60 < 15 else GOOD, 100000 + minute * 60)
            if notice: notices.append(notice)
        self.assertEqual(len(notices), 1)
        self.assertEqual(state['last_warning_at'], 100600)

    def test_critical_escalation_is_confirmed_and_bounded(self):
        state = {}; notices = []
        for minute in range(40):
            sample = DATA if minute < 15 else DOWN
            state, notice = watchdog.advance(state, sample, 100000 + minute * 60)
            if notice: notices.append((minute, notice))
        self.assertEqual([m for m, _ in notices], [10, 18])
        self.assertEqual([n['priority'] for _, n in notices], [3, 4])

    def test_brief_recovery_does_not_reopen_an_incident(self):
        state = {}; notices = []
        for minute in range(300):
            state, notice = watchdog.advance(state, GOOD if minute % 20 == 19 else DATA, 100000 + minute * 60)
            if notice: notices.append(notice)
        self.assertEqual(len(notices), 1)

    def test_core_failure_is_not_a_price_detection_outage(self):
        self.assertEqual(watchdog.classify(DATA)[0], 1)
        price_down = dict(DATA, priceAlerts={'streamFresh': False, 'fallbackFresh': False, 'deliveryBacklog': 0})
        self.assertEqual(watchdog.classify(price_down)[0], 2)
        one_feed = dict(GOOD, streamFresh=False)
        self.assertEqual(watchdog.classify(one_feed)[0], 1)

    def test_budget_survives_state_file_and_uncertain_delivery(self):
        state = {}; now = 100000
        for _ in range(11):
            state, notice = watchdog.advance(state, DATA, now); now += 60
        self.assertIsNotNone(notice)
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'state.json'
            watchdog.atomic_state(path, state)
            restored = json.loads(path.read_text())
            _, replay = watchdog.advance(restored, DATA, now)
            self.assertIsNone(replay)

    def test_legacy_state_migration_keeps_the_previous_notice_budget(self):
        state={'at':100000,'notified':False}
        for minute in range(20):
            state,notice=watchdog.advance(state,DATA,100100+minute*60)
            self.assertIsNone(notice)
        self.assertEqual(state['last_warning_at'],100000)

    def test_price_alert_delivery_code_is_outside_health_rate_limits(self):
        source = (pathlib.Path(__file__).resolve().parents[1] / 'runtime/watchdog.ts').read_text()
        self.assertNotIn('sendEmail', source)
        self.assertNotIn('sendNtfy', source)
        state, notice = watchdog.advance({}, dict(GOOD, maintenance=True), 100000)
        self.assertIsNone(notice)


if __name__ == '__main__':
    unittest.main()
