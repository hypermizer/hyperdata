#!/usr/bin/env python3
"""One notification owner for confirmed incidents, independent of asset-price alerts."""
import copy
import fcntl
import json
import pathlib
import ssl
import time
import urllib.request

DAY = 86400
CONFIRM = {1: 600, 2: 180}
RECOVERY = 600


def classify(sample):
    if sample is None:
        return 2, "The private Hyperdata server cannot be reached."
    if sample.get("maintenance") is True:
        return 0, "maintenance"
    prices = sample.get("priceAlerts", sample)
    # App-data readiness must never be described as a price-alert outage.
    if prices.get("deliveryBacklog", 0):
        return 2, "Price-notification delivery has a sustained backlog."
    if not prices.get("streamFresh") and not prices.get("fallbackFresh"):
        return 2, "Both price-detection feeds are unavailable."
    if not prices.get("streamFresh") or not prices.get("fallbackFresh"):
        return 1, "Price monitoring has lost one of its independent feeds."
    core = sample.get("core")
    if core and core.get("healthy") is not True:
        parts = []
        if not core.get("paperFresh", True):
            parts.append("paper processing")
        if not core.get("accountSyncFresh", True):
            parts.append("account synchronization")
        if not core.get("historyFresh", True):
            parts.append("market history collection")
        if not core.get("markReferencesFresh", True):
            parts.append("dot reference coverage")
        return 1, "A sustained app-data issue needs attention: " + ", ".join(parts or ["data services"]) + ". Price detection remains available."
    return 0, "healthy"


def advance(previous, sample, now):
    """Pure state machine. Reserve a notice BEFORE publishing; never send recoveries."""
    state = copy.deepcopy(previous or {})
    if "last_warning_at" not in state and isinstance(state.get("at"), (int, float)) and state["at"] > 0:
        state["last_warning_at"] = state["at"] / 1000 if state["at"] > 100000000000 else state["at"]
    for key, default in {
        "candidate_level": 0, "candidate_since": None, "bad_samples": 0,
        "healthy_since": None, "incident_level": 0,
        "last_warning_at": None, "last_critical_at": None,
    }.items():
        state.setdefault(key, default)
    level, reason = classify(sample)
    state.update(checked_at=now, level=level, reason=reason)
    if level == 0:
        state["candidate_level"] = 0
        state["candidate_since"] = None
        state["bad_samples"] = 0
        if state["healthy_since"] is None:
            state["healthy_since"] = now
        if now - state["healthy_since"] >= RECOVERY:
            state["incident_level"] = 0
        return state, None
    state["healthy_since"] = None
    if state["candidate_level"] != level or state["candidate_since"] is None:
        state.update(candidate_level=level, candidate_since=now, bad_samples=1)
    else:
        state["bad_samples"] += 1
    if state["bad_samples"] < 3 or now - state["candidate_since"] < CONFIRM[level]:
        return state, None
    if level <= state["incident_level"]:
        return state, None
    # Recovery must never erase the notification budget. Even if many separate
    # incidents flap, there is at most one warning and one critical notice/day.
    state["incident_level"] = level
    budget = "last_critical_at" if level == 2 else "last_warning_at"
    if state[budget] is not None and now - state[budget] < DAY:
        state["suppressed_at"] = now
        return state, None
    state[budget] = now
    return state, {"title": "HYPERDATA · confirmed " + ("outage" if level == 2 else "data issue"),
                   "message": reason, "priority": 4 if level == 2 else 3}


def atomic_state(path, state):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state))
    temporary.chmod(0o600)
    temporary.replace(path)


def run_monitor():
    root = pathlib.Path('/etc/hyperdata-health')
    config = json.loads((root / 'config.json').read_text())
    state_path = pathlib.Path('/var/lib/hyperdata-health/state.json')
    try:
        previous = json.loads(state_path.read_text())
    except FileNotFoundError:
        previous = {}
    ctx = ssl.create_default_context()
    ctx.load_cert_chain(str(root / 'client.crt'), str(root / 'client.key'))
    sample = None
    try:
        with urllib.request.urlopen(config['origin'] + '/api/health', context=ctx, timeout=12) as response:
            sample = json.load(response)
    except Exception:
        pass
    state, notice = advance(previous, sample, time.time())
    # A restart or an uncertain provider response cannot replay a published notice.
    atomic_state(state_path, state)
    if notice and config.get('notifications_enabled', True):
        payload = dict(notice, topic=config['ntfy_topic'], click=config.get('app_origin', config['origin']) + '/#/alerts')
        request = urllib.request.Request(config['ntfy_url'], data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                accepted = json.load(response)
            if accepted.get('event') != 'message':
                raise RuntimeError('Health notice unconfirmed')
            state['last_delivery'] = 'accepted'
        except Exception:
            state['last_delivery'] = 'failed_or_uncertain'
            atomic_state(state_path, state)
            raise RuntimeError('Health notice outcome unavailable; replay suppressed') from None
        atomic_state(state_path, state)
    print('Hyperdata health: ' + state['reason'] + ('; confirmed incident notification reserved' if notice else '; no notification'))


def main():
    state_dir = pathlib.Path('/var/lib/hyperdata-health')
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (state_dir / 'monitor.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Hyperdata health: observer already running; no notification')
            return
        run_monitor()


if __name__ == '__main__':
    main()
