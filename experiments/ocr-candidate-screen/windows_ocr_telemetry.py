"""Read Windows performance counters and GPU clocks during an owned OCR benchmark."""
import argparse
import ctypes as c
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import subprocess
import time


class CounterValue(c.Structure):
    _fields_ = [("status", w.DWORD), ("value", c.c_double)]


class CounterItem(c.Structure):
    _fields_ = [("name", w.LPWSTR), ("value", CounterValue)]


class Counters:
    paths = {
        "frequency_mhz": r"\Processor Information(*)\Actual Frequency",
        "cpu_busy": r"\Processor Information(*)\% Processor Time",
        "performance_limit": r"\Processor Information(*)\% Performance Limit",
        "limit_flags": r"\Processor Information(*)\Performance Limit Flags",
        "gpu_busy": r"\GPU Engine(*)\Utilization Percentage",
        "thermal_raw": r"\Thermal Zone Information(*)\High Precision Temperature",
        "thermal_throttle": r"\Thermal Zone Information(*)\Throttle Reasons",
        "available_mb": r"\Memory\Available MBytes",
        "page_reads": r"\Memory\Page Reads/sec",
        "process_ids": r"\Process V2(*)\Process ID",
        "process_cpu": r"\Process V2(*)\% Processor Time",
    }

    def __init__(self):
        self.dll = c.WinDLL("pdh")
        self.dll.PdhOpenQueryW.argtypes = [w.LPCWSTR, c.c_size_t, c.POINTER(w.HANDLE)]
        self.dll.PdhAddEnglishCounterW.argtypes = [w.HANDLE, w.LPCWSTR, c.c_size_t, c.POINTER(w.HANDLE)]
        self.dll.PdhCollectQueryData.argtypes = [w.HANDLE]
        self.dll.PdhGetFormattedCounterArrayW.argtypes = [w.HANDLE, w.DWORD, c.POINTER(w.DWORD), c.POINTER(w.DWORD), c.c_void_p]
        self.dll.PdhCloseQuery.argtypes = [w.HANDLE]
        self.query = w.HANDLE()
        assert self.dll.PdhOpenQueryW(None, 0, c.byref(self.query)) == 0
        self.handles = {}
        self.errors = {}
        for name, path in self.paths.items():
            handle = w.HANDLE()
            status = self.dll.PdhAddEnglishCounterW(self.query, path, 0, c.byref(handle))
            if status == 0:
                self.handles[name] = handle
            else:
                self.errors[name] = hex(status & 0xFFFFFFFF)
        self.dll.PdhCollectQueryData(self.query)

    def sample(self):
        assert self.dll.PdhCollectQueryData(self.query) == 0
        result = {}
        for name, handle in self.handles.items():
            size, count = w.DWORD(), w.DWORD()
            self.dll.PdhGetFormattedCounterArrayW(handle, 0x200 | 0x8000, c.byref(size), c.byref(count), None)
            if not size.value:
                continue
            buffer = c.create_string_buffer(size.value)
            status = self.dll.PdhGetFormattedCounterArrayW(handle, 0x200 | 0x8000, c.byref(size), c.byref(count), buffer)
            if status == 0:
                values = c.cast(buffer, c.POINTER(CounterItem))
                result[name] = {values[i].name: round(values[i].value.value, 3)
                                for i in range(count.value) if values[i].value.status in (0, 1)}
        ids = result.pop("process_ids", {})
        cpu = result.pop("process_cpu", {})
        result["processes"] = sorted([
            {"name": name, "pid": int(ids[name]), "cpu_percent": round(value / os.cpu_count(), 2)}
            for name, value in cpu.items() if name in ids and ids[name] > 0 and name.lower() != "_total" and value > 1
        ], key=lambda row: row["cpu_percent"], reverse=True)[:20]
        result["gpu_busy"] = {name: value for name, value in result.get("gpu_busy", {}).items() if value > .1}
        return result

    def close(self):
        self.dll.PdhCloseQuery(self.query)


class Luid(c.Structure):
    _fields_ = [("low", w.DWORD), ("high", w.LONG)]


class Adapter(c.Structure):
    _fields_ = [("handle", w.UINT), ("luid", Luid), ("sources", w.ULONG), ("precise", w.BOOL)]


class AdapterList(c.Structure):
    _fields_ = [("count", w.ULONG), ("adapters", c.POINTER(Adapter))]


class QueryAdapter(c.Structure):
    _fields_ = [("handle", w.UINT), ("kind", w.UINT), ("data", c.c_void_p), ("size", w.UINT)]


class NodePerf(c.Structure):
    _fields_ = [("node", w.UINT), ("physical", w.UINT), ("frequency", c.c_uint64),
                ("maximum", c.c_uint64), ("overclock_max", c.c_uint64), ("voltage", w.ULONG),
                ("voltage_max", w.ULONG), ("voltage_oc", w.ULONG), ("transition", c.c_uint64)]


class AdapterPerf(c.Structure):
    _fields_ = [("physical", w.UINT), ("memory_frequency", c.c_uint64), ("max_memory_frequency", c.c_uint64),
                ("oc_memory_frequency", c.c_uint64), ("memory_bandwidth", c.c_uint64), ("pcie_bandwidth", c.c_uint64),
                ("fan", w.ULONG), ("power", w.ULONG), ("temperature", w.ULONG), ("power_override", c.c_ubyte)]


class GpuClocks:
    def __init__(self):
        self.dll = c.WinDLL("gdi32")
        self.dll.D3DKMTEnumAdapters2.argtypes = [c.POINTER(AdapterList)]
        self.dll.D3DKMTQueryAdapterInfo.argtypes = [c.POINTER(QueryAdapter)]
        self.dll.D3DKMTCloseAdapter.argtypes = [c.POINTER(w.UINT)]
        self.adapters = (Adapter * 16)()
        listing = AdapterList(16, self.adapters)
        self.status = self.dll.D3DKMTEnumAdapters2(c.byref(listing))
        self.count = listing.count if self.status == 0 else 0
        assert c.sizeof(NodePerf) == 56 and c.sizeof(AdapterPerf) == 64

    def sample(self):
        result = []
        for adapter in list(self.adapters)[:self.count]:
            row = {"luid": f"{adapter.luid.high & 0xFFFFFFFF:08x}:{adapter.luid.low:08x}"}
            for kind, data, prefix in [(61, NodePerf(), "engine"), (62, AdapterPerf(), "adapter")]:
                query = QueryAdapter(adapter.handle, kind, c.addressof(data), c.sizeof(data))
                status = self.dll.D3DKMTQueryAdapterInfo(c.byref(query))
                if status:
                    row[prefix + "_status"] = hex(status & 0xFFFFFFFF)
                elif prefix == "engine":
                    row.update(frequency_mhz=data.frequency / 1e6, max_frequency_mhz=data.maximum / 1e6,
                               frequency_reported=bool(data.maximum))
                else:
                    row.update(memory_mhz=data.memory_frequency / 1e6, temperature_c=data.temperature / 10, power_percent=data.power / 10)
            result.append(row)
        return result

    def close(self):
        for adapter in list(self.adapters)[:self.count]:
            handle = w.UINT(adapter.handle)
            self.dll.D3DKMTCloseAdapter(c.byref(handle))


class IntelInit(c.Structure):
    _fields_ = [("size", w.DWORD), ("version", c.c_uint8), ("app", w.DWORD),
                ("flags", w.DWORD), ("supported", w.DWORD), ("uid", w.DWORD * 4)]


class IntelState(c.Structure):
    _fields_ = [("size", w.DWORD), ("version", c.c_uint8), ("voltage", c.c_double),
                ("request", c.c_double), ("tdp", c.c_double), ("efficient", c.c_double),
                ("actual", c.c_double), ("throttle", w.DWORD)]


class IntelFrequency:
    """Read-only IGCL API; unsupported machines retain a recorded error."""
    def __init__(self):
        self.handle, self.domains, self.error = c.c_void_p(), [], None
        try:
            self.dll = c.CDLL(str(Path(os.environ["WINDIR"]) / "System32/ControlLib.dll"))
            self.dll.ctlInit.argtypes = [c.POINTER(IntelInit), c.POINTER(c.c_void_p)]
            self.dll.ctlClose.argtypes = [c.c_void_p]
            self.dll.ctlEnumerateDevices.argtypes = [c.c_void_p, c.POINTER(w.DWORD), c.POINTER(c.c_void_p)]
            self.dll.ctlEnumFrequencyDomains.argtypes = self.dll.ctlEnumerateDevices.argtypes
            self.dll.ctlFrequencyGetState.argtypes = [c.c_void_p, c.POINTER(IntelState)]
            assert c.sizeof(IntelInit) == 36 and c.sizeof(IntelState) == 56
            args = IntelInit(c.sizeof(IntelInit), 0, 1 << 16, 1)
            self.check(self.dll.ctlInit(c.byref(args), c.byref(self.handle)))
            def listing(function, parent):
                count = w.DWORD()
                self.check(function(parent, c.byref(count), None))
                handles = (c.c_void_p * count.value)()
                self.check(function(parent, c.byref(count), handles))
                return list(handles)
            for device in listing(self.dll.ctlEnumerateDevices, self.handle):
                self.domains.extend(listing(self.dll.ctlEnumFrequencyDomains, device))
        except (OSError, AssertionError) as error:
            self.error = str(error)

    @staticmethod
    def check(status):
        assert status == 0, hex(status & 0xFFFFFFFF)

    def sample(self):
        result = []
        for domain in self.domains:
            state = IntelState(c.sizeof(IntelState), 0)
            status = self.dll.ctlFrequencyGetState(domain, c.byref(state))
            result.append({"status": hex(status & 0xFFFFFFFF), "actual_mhz": state.actual,
                           "requested_mhz": state.request, "tdp_mhz": state.tdp,
                           "throttle_reasons": state.throttle})
        return result

    def close(self):
        if self.handle:
            self.dll.ctlClose(self.handle)


def cpu_sets():
    kernel = c.WinDLL("kernel32", use_last_error=True)
    kernel.GetSystemCpuSetInformation.argtypes = [c.c_void_p, w.ULONG, c.POINTER(w.ULONG), w.HANDLE, w.ULONG]
    size = w.ULONG()
    kernel.GetSystemCpuSetInformation(None, 0, c.byref(size), None, 0)
    buffer = c.create_string_buffer(size.value)
    assert kernel.GetSystemCpuSetInformation(buffer, size, c.byref(size), None, 0)
    result, offset = [], 0
    while offset < size.value:
        raw = buffer.raw[offset:]
        length = int.from_bytes(raw[:4], "little")
        assert length >= 32 and offset + length <= size.value
        if int.from_bytes(raw[4:8], "little") == 0:
            result.append({"id": int.from_bytes(raw[8:12], "little"), "group": int.from_bytes(raw[12:14], "little"),
                           "logical": raw[14], "core": raw[15], "efficiency_class": raw[18], "flags": raw[19]})
        offset += length
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=2)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    args.output.parent.mkdir(parents=True, exist_ok=True)
    counters, gpu, intel, child = Counters(), GpuClocks(), IntelFrequency(), None
    try:
        with args.output.open("w", encoding="utf-8", newline="\n") as output:
            output.write(json.dumps({"kind": "metadata", "cpu_sets": cpu_sets(), "counter_errors": counters.errors, "intel_frequency_error": intel.error}) + "\n")
            if command:
                child = subprocess.Popen(command)
            count = 0
            while child is not None and child.poll() is None or child is None and count < args.samples:
                time.sleep(1)
                started = time.perf_counter()
                row = {"kind": "sample", "utc_seconds": time.time(), **counters.sample(), "gpu_clocks": gpu.sample(), "intel_frequency": intel.sample()}
                row["sample_cost_seconds"] = time.perf_counter() - started
                output.write(json.dumps(row) + "\n"); output.flush()
                count += 1
            if child:
                raise SystemExit(child.returncode)
    finally:
        if child is not None and child.poll() is None:
            child.terminate(); child.wait(timeout=10)
        intel.close(); gpu.close(); counters.close()


if __name__ == "__main__":
    main()
