"""Minimal TypeSafe System One API demo: one call, one question of each type.

Reads TYPESAFE_API_KEY from the environment. No third-party dependencies.

Usage:
    python demo.py [state-text]
"""

import json
import os
import sys
import urllib.request

API_URL = "https://api.typesafe.ai/v1/systemone"

DEFAULT_STATE = (
    "Hi, I've been trying to connect my Stripe account for 3 days and it keeps "
    "failing. I'm losing sales. Please help ASAP."
)

QUESTIONS = {
    "department": {
        "type": "choice",
        "instructions": "Which team should handle this",
        "criteria": {
            "billing": "Payment or subscription issues",
            "technical": "Bugs or integration problems",
            "sales": "Pricing or account questions",
        },
    },
    "frustration": {
        "type": "score",
        "instructions": "How frustrated the customer appears",
        "criteria": [
            "Calm, just stating facts",
            "Frustrated but civil",
            "Very angry, strong language",
        ],
    },
    "is_urgent": {
        "type": "noul",
        "instructions": "The message conveys urgency or time-sensitivity",
    },
}


def main() -> int:
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        print("TYPESAFE_API_KEY is not set", file=sys.stderr)
        return 2

    state = " ".join(sys.argv[1:]) or DEFAULT_STATE
    body = json.dumps({"state": state, "model": "jev-latest", "questions": QUESTIONS}).encode()

    request = urllib.request.Request(
        API_URL,
        data=body,
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        print("HTTP " + str(error.code) + ": " + detail, file=sys.stderr)
        return 1

    print(json.dumps(payload, indent=2))
    answers = payload.get("answers", {})
    print("---")
    print("choice:    " + str(answers.get("department", {}).get("choice")))
    print("score:     " + str(answers.get("frustration", {}).get("score")))
    print("noul:      " + str(answers.get("is_urgent", {}).get("noul")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
