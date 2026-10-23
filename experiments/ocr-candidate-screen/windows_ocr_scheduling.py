"""Inspect or temporarily change only the OCR benchmark's supplied Chromium PIDs."""
import argparse
import ctypes as c
from ctypes import wintypes as w
import json
import sys
from pathlib import Path

from windows_ocr_telemetry import cpu_sets


class Power(c.Structure):
    _fields_ = [("version", w.ULONG), ("control", w.ULONG), ("state", w.ULONG)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--processes", required=True)
    parser.add_argument("--saved", type=Path, required=True)
    parser.add_argument("--policy", choices=["inspect", "default", "pcores", "ecores", "no-eco", "above-normal"], default="inspect")
    args = parser.parse_args()
    processes = json.loads(args.processes)
    assert isinstance(processes, list) and processes
    assert all(isinstance(p["id"], int) and p["id"] > 4 for p in processes)
    saved = json.loads(args.saved.read_text()) if args.saved.exists() else {}
    kernel = c.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]; kernel.OpenProcess.restype = w.HANDLE
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.GetProcessAffinityMask.argtypes = [w.HANDLE, c.POINTER(c.c_size_t), c.POINTER(c.c_size_t)]
    kernel.SetProcessAffinityMask.argtypes = [w.HANDLE, c.c_size_t]
    kernel.GetPriorityClass.argtypes = [w.HANDLE]; kernel.GetPriorityClass.restype = w.DWORD
    kernel.SetPriorityClass.argtypes = [w.HANDLE, w.DWORD]
    kernel.GetProcessInformation.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
    kernel.SetProcessInformation.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
    sets = cpu_sets()
    assert all(row["group"] == 0 for row in sets), "This diagnostic supports one processor group"
    classes = [row["efficiency_class"] for row in sets]
    p_mask = sum(1 << row["logical"] for row in sets if row["efficiency_class"] == max(classes))
    e_mask = sum(1 << row["logical"] for row in sets if row["efficiency_class"] == min(classes))
    result = []
    for process in processes:
        pid = process["id"]
        handle = kernel.OpenProcess(0x1400 | (0x200 if args.policy != "inspect" else 0), False, pid)
        if not handle:
            result.append({**process, "open_error": c.get_last_error()}); continue
        try:
            def state():
                mask, system = c.c_size_t(), c.c_size_t()
                assert kernel.GetProcessAffinityMask(handle, c.byref(mask), c.byref(system)), c.get_last_error()
                power = Power(1, 0, 0)
                assert kernel.GetProcessInformation(handle, 4, c.byref(power), c.sizeof(power)), c.get_last_error()
                return {"affinity": mask.value, "priority": kernel.GetPriorityClass(handle),
                        "power_control": power.control, "power_state": power.state}
            before = state()
            saved.setdefault(str(pid), before)
            original = saved[str(pid)]
            if args.policy != "inspect":
                mask = p_mask if args.policy == "pcores" else e_mask if args.policy == "ecores" else original["affinity"]
                priority = 0x8000 if args.policy == "above-normal" else original["priority"]
                power = Power(1, original["power_control"], original["power_state"])
                if args.policy == "no-eco":
                    power.control |= 1; power.state &= ~1
                assert kernel.SetProcessAffinityMask(handle, mask), c.get_last_error()
                assert kernel.SetPriorityClass(handle, priority), c.get_last_error()
                assert kernel.SetProcessInformation(handle, 4, c.byref(power), c.sizeof(power)), c.get_last_error()
            result.append({**process, "before": before, "after": state()})
        finally:
            kernel.CloseHandle(handle)
    args.saved.parent.mkdir(parents=True, exist_ok=True)
    args.saved.write_text(json.dumps(saved, indent=2) + "\n")
    print(json.dumps({"policy": args.policy, "p_mask": p_mask, "e_mask": e_mask, "processes": result}))


if __name__ == "__main__":
    if sys.argv[1:] == ["--burn"]:
        value = 1
        while True:
            value = (value * 1664525 + 1013904223) & 0xFFFFFFFF
    else:
        main()
