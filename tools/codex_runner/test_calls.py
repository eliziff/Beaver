"""Invented requests, with a provider double at the expensive process boundary."""
import gzip
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tools.codex_runner.artifacts import atomic_json, digest, fingerprint, read_json
from tools.codex_runner.calls import CallPolicy, call, call_key, prepare_call


class PreparedCalls(unittest.TestCase):
    def test_log_cleanup_cannot_mask_a_success_or_a_provider_failure(self):
        from tools.codex_runner.calls import AttemptsExhausted
        for fails in (False, True):
            with self.subTest(provider_fails=fails), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                schema = root / "schema.json"
                atomic_json(schema, {"type": "object"})
                args = SimpleNamespace(model="invented-model", effort="low", attempts=1, timeout=1, max_calls=1)
                policy = CallPolicy("Read the evidence.", {}, lambda p, e, previous: p,
                                    lambda exc, response: str(exc), "Rejected: ")
                original_unlink = Path.unlink

                def locked_log(path, *args, **kwargs):
                    if path.name == "events.jsonl":
                        raise PermissionError("Invented process still holds its log")
                    return original_unlink(path, *args, **kwargs)

                def provider(**kwargs):
                    (kwargs["work_dir"] / "events.jsonl").write_text('{"type":"turn.completed","usage":{"input_tokens":7}}\n')
                    if fails:
                        raise TimeoutError("Invented provider deadline")
                    return {"count": 4}

                with patch.object(Path, "unlink", locked_log):
                    if fails:
                        with self.assertRaisesRegex(AttemptsExhausted, "Invented provider deadline"):
                            call("Count invented squares.", schema, [], root / "calls", args,
                                 lambda value: value, provider, policy=policy)
                    else:
                        self.assertEqual(call("Count invented squares.", schema, [], root / "calls", args,
                                             lambda value: value, provider, policy=policy), {"count": 4})
                receipt = read_json(next((root / "calls").glob("*/receipt.json")))
                attempt = receipt["attempts"][0]
                self.assertEqual(attempt["status"], "failed" if fails else "complete")
                self.assertEqual(attempt["usage"], {"input_tokens": 7})
                self.assertIn("events.jsonl", attempt["artifact_errors"])

    def test_preparation_resume_and_cache_validation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            schema = root / "answer-schema.json"
            atomic_json(schema, {"type": "object", "properties": {"count": {"type": "integer"}},
                                 "required": ["count"], "additionalProperties": False})
            picture = root / "page.png"
            picture.write_bytes(b"independently invented image placeholder")
            args = SimpleNamespace(model="test-model", effort="low", attempts=1, timeout=1, max_calls=1)
            policy = CallPolicy("Read the supplied evidence.", {}, lambda p, e, previous: p,
                                lambda exc, response: str(exc), "Rejected: ")
            prompt = "How many triangles are on the sheet?"
            key = call_key(prompt, read_json(schema), [picture], args, policy)
            self.assertEqual(key, fingerprint({"prompt": prompt, "schema": read_json(schema),
                "instructions": policy.instructions, "config": {}, "images": [digest(picture)],
                "model": args.model, "effort": args.effort}))
            prepared = prepare_call(prompt, schema, [picture], root / "calls", args, policy=policy)
            self.assertFalse((prepared / "receipt.json").exists())
            request = read_json(prepared / "request.json")
            self.assertEqual(request["key"], key)
            self.assertEqual((prepared / request["images"][0]["path"]).resolve(), picture)
            self.assertEqual(gzip.decompress((prepared / "prompt.txt.gz").read_bytes()).decode(), prompt)
            budget = {"calls": 0}

            def provider(**kwargs):
                self.assertEqual(kwargs["schema_path"], (prepared / "schema.json").resolve())
                return {"count": 4}

            validate = lambda value: value["count"]
            self.assertEqual(call(prompt, schema, [picture], root / "calls", args, validate, provider, budget, policy=policy), 4)
            self.assertEqual(call(prompt, schema, [picture], root / "calls", args, validate, provider, budget, policy=policy), 4)
            self.assertEqual(budget["calls"], 1)

            def reject(value):
                raise ValueError("Count is not accepted by the task")

            with self.assertRaisesRegex(ValueError, "Model-call limit"):
                call(prompt, schema, [picture], root / "calls", args, reject, provider, budget, policy=policy)
            self.assertEqual(len(read_json(prepared / "receipt.json")["cache_rejections"]), 1)
            picture.write_bytes(b"a different independently invented sheet")
            changed = prepare_call(prompt, schema, [picture], root / "calls", args, policy=policy)
            self.assertNotEqual(changed, prepared)
            self.assertFalse((changed / "response.json").exists())


if __name__ == "__main__":
    unittest.main()
