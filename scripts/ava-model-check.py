#!/usr/bin/env python3
"""ava-model-check.py — does the pinned LLM actually answer a call?

`/v1/models` answering 200 is not a check. It lists ids that then take 20 s,
return an empty `content`, or 429 — and on this estate that mistake pinned a
model (`gemini/gemini-3.1-flash-lite`) which ended every call in dead air while
the engine's own `/health` said `healthy` and the pipeline said `valid`.

What breaks a call is not visible in a listing:

  * **time to first token.** The engine streams on a budget
    (`options.llm.timeout_sec`, else the provider's 5 s) and falls back to a
    serial request when it expires; the serial path on the model above measured
    21 s, so the caller hears the greeting and then silence.
  * **whether a reply arrives as `content` at all.** Some gateway routes emit
    `reasoning_content` and spend the whole `max_tokens` on reasoning tokens,
    leaving `content` empty — or truncated to half a sentence ("We are open
    from 9 a."), which is what "the call cut out" sounds like.

So this asks for a real completion, streaming, the way the engine does, using
the model and budget the engine is configured with.

Usage (from the repo root, on the voice host, as an operator):

    python3 scripts/ava-model-check.py                # check the pinned model
    python3 scripts/ava-model-check.py --json         # machine-readable
    python3 scripts/ava-model-check.py --list         # what the gateway offers
    python3 scripts/ava-model-check.py gemini/foo ...  # probe specific ids

Env / args: AVA_LLM_BASE_URL and OMNIROUTE_API_KEY (or OPENAI_API_KEY) — the
engine's own two, so this measures the hop a call takes.

Exit: 0 the pinned model is usable — 1 it is not (names why) — 2 the gateway
could not be read at all.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
CONFIG = REPO / "config" / "ava" / "ai-agent.yaml"

# A real receptionist turn: short question, short answer expected. A prompt that
# invites reasoning hides a reasoning-only route behind a long reply.
PROMPT = "A caller asks when you are open. Answer in one short sentence."

# A caller starts talking over roughly two seconds of silence. This is stricter
# than the engine's timeout on purpose: surviving the timeout is not the bar,
# holding a conversation is. Reported, not enforced, so a near-miss is visible
# rather than fatal.
TTFT_TARGET_SEC = 2.0


def chat_model_from_config(path: Path) -> tuple[str, int]:
    """The model and max_tokens the engine will use, read from the config.

    Resolves the `${AVA_LLM_MODEL:-fallback}` form the template uses, so the
    checked value is the one a running engine would pick with no environment.
    """
    text = path.read_text(encoding="utf-8")
    match = re.search(r'chat_model:\s*"\$\{AVA_LLM_MODEL:-([^}]+)\}"', text)
    if not match:
        match = re.search(r'chat_model:\s*"?([A-Za-z0-9_./:-]+)"?', text)
    if not match:
        raise SystemExit(f"{path}: no chat_model found")
    model = match.group(1)
    cap = re.search(r"max_tokens:\s*(\d+)", text)
    return model, int(cap.group(1)) if cap else 200


def list_models(base: str, key: str) -> list[str]:
    req = urllib.request.Request(
        f"{base.rstrip('/')}/models", headers={"Authorization": f"Bearer {key}"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read() or b"{}")
    return [str(m.get("id", "")) for m in data.get("data", []) if m.get("id")]


def probe(base: str, key: str, model: str, max_tokens: int, timeout: float) -> dict:
    """One streaming completion. Never raises — a failure is a result."""
    body = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": PROMPT}],
            "max_tokens": max_tokens,
            "stream": True,
        }
    ).encode()
    req = urllib.request.Request(
        f"{base.rstrip('/')}/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    started = time.time()
    ttft = None
    content = ""
    reasoning_first = False
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                except ValueError:
                    continue
                for choice in chunk.get("choices") or []:
                    delta = choice.get("delta") or {}
                    if delta.get("reasoning_content") and ttft is None:
                        reasoning_first = True
                    text = delta.get("content")
                    if text:
                        if ttft is None:
                            ttft = time.time() - started
                        content += text
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:160].replace("\n", " ")
        return {"model": model, "error": f"HTTP {exc.code} {detail}"}
    except Exception as exc:  # noqa: BLE001 — a timeout is a finding, not a crash
        return {"model": model, "error": f"{exc.__class__.__name__}: {exc}"[:160]}
    return {
        "model": model,
        "ttft": ttft,
        "total": time.time() - started,
        "content_chars": len(content),
        # Reasoning that arrives before any content is the failure that matters:
        # the agent has nothing to say and the caller hears silence.
        "reasoning_first": reasoning_first,
        "content": content[:120].replace("\n", " "),
    }


def failure(row: dict) -> str:
    """Why this model cannot answer a call AT ALL. This is the exit status.

    Kept strictly separate from the slowness below, because they are different
    findings with different remedies: this one means the caller hears nothing,
    the other means the caller waits. Folding a slow-but-working model into
    this would send an operator hunting for a replacement model when the fix is
    a gateway parameter (see `reasoning_effort` in docs/ava-integration.md).
    """
    if "error" in row:
        return row["error"]
    if row["ttft"] is None:
        return "no content at all — the reply never arrived as `content`"
    if row["content_chars"] == 0:
        return "empty content — the budget went to reasoning tokens"
    return ""


def slowness(row: dict) -> str:
    """Why this model is working but slow. Reported, never fatal."""
    if failure(row):
        return ""
    reasons = []
    if row["reasoning_first"]:
        reasons.append("reasoning tokens before the content")
    if row["ttft"] is not None and row["ttft"] > TTFT_TARGET_SEC:
        reasons.append(f"{row['ttft']:.2f}s to first token")
    if not reasons:
        return ""
    return ", ".join(reasons) + f" (target {TTFT_TARGET_SEC:.1f}s, and none at all)"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("models", nargs="*", help="explicit ids (default: the pinned one)")
    parser.add_argument("--base-url", default=os.environ.get("AVA_LLM_BASE_URL", ""))
    parser.add_argument("--api-key", default="")
    parser.add_argument("--config", default=str(CONFIG))
    parser.add_argument("--max-tokens", type=int, default=0, help="default: config's")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    base = args.base_url or "http://192.168.1.46:20129/v1"
    key = (
        args.api_key
        or os.environ.get("OMNIROUTE_API_KEY", "")
        or os.environ.get("OPENAI_API_KEY", "")
    )

    if args.list:
        try:
            for model in list_models(base, key):
                print(model)
        except Exception as exc:  # noqa: BLE001
            print(f"ava-model-check: {base} unreachable: {exc}", file=sys.stderr)
            return 2
        return 0

    pinned, config_cap = chat_model_from_config(Path(args.config))
    targets = args.models or [pinned]
    cap = args.max_tokens or config_cap

    try:
        rows = [
            probe(base, key, model, cap, args.timeout)
            for model in targets
        ]
    except Exception as exc:  # noqa: BLE001
        print(f"ava-model-check: {base} unreachable: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps({"pinned": pinned, "max_tokens": cap, "results": rows}, indent=2))
    else:
        print(f"gateway {base}   model {pinned}   max_tokens {cap}")
        for row in rows:
            if failure(row):
                print(f"  FAIL {row['model']}: {failure(row)}")
                continue
            ttft = f"{row['ttft']:.2f}s" if row["ttft"] is not None else "none"
            print(
                f"  {'slow' if slowness(row) else 'ok  '} {row['model']}: "
                f"ttft {ttft}, {row['content_chars']} chars, "
                f"total {row['total']:.2f}s"
            )
            if row["content"]:
                print(f"         said: {row['content']!r}")
            if slowness(row):
                print(f"         slow: {slowness(row)}")

    # Only the pinned model's verdict changes the exit status: probing an
    # alternative is a comparison, not a regression.
    failed = [r for r in rows if failure(r) and r["model"] == pinned]
    if failed:
        print(
            "ava-model-check: the pinned model cannot hold a conversation — "
            "a call answered by it goes silent after the greeting",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
