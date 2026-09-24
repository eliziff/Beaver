"""Runs one model Python program against document.docx in the current (private) directory.

Guard, in order: a Windows Job Object (one process, memory cap, kill-on-close) or
POSIX rlimits; then sys.addaudithook refusing sockets, process creation, native
code loading and file access outside this directory and the Python installation.
An audit hook is not an OS sandbox: it narrows accidents and casual escapes, while
the verifier in a separate process treats the output as untrusted.
Request (stdin JSON): {program, mode: tracked|direct|read-only}. Reply: one JSON line.
"""
from __future__ import annotations
import ast
import io
import json
import os
import sys
import traceback

MEMORY = 1536 << 20
HERE = os.path.dirname(os.path.abspath(__file__))


def limit_process():
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes as w
        class Basic(ctypes.Structure):
            _fields_ = [('ProcessTime', ctypes.c_int64), ('JobTime', ctypes.c_int64), ('Flags', w.DWORD),
                        ('Min', ctypes.c_size_t), ('Max', ctypes.c_size_t), ('Active', w.DWORD),
                        ('Affinity', ctypes.c_size_t), ('Priority', w.DWORD), ('Scheduling', w.DWORD)]
        class IO(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in ('R', 'W', 'O', 'RB', 'WB', 'OB')]
        class Limits(ctypes.Structure):
            _fields_ = [('Basic', Basic), ('IO', IO), ('ProcessMemory', ctypes.c_size_t),
                        ('JobMemory', ctypes.c_size_t), ('PeakProcess', ctypes.c_size_t), ('PeakJob', ctypes.c_size_t)]
        k = ctypes.WinDLL('kernel32', use_last_error=True)
        k.CreateJobObjectW.restype = w.HANDLE
        k.GetCurrentProcess.restype = w.HANDLE
        k.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        k.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        job = k.CreateJobObjectW(None, None)
        limit = Limits()
        # KILL_ON_JOB_CLOSE | PROCESS_MEMORY | ACTIVE_PROCESS(1): the kernel refuses child processes.
        limit.Basic.Flags, limit.Basic.Active, limit.ProcessMemory = 0x2000 | 0x100 | 0x8, 1, MEMORY
        if not job or not k.SetInformationJobObject(job, 9, ctypes.byref(limit), ctypes.sizeof(limit)) \
                or not k.AssignProcessToJobObject(job, k.GetCurrentProcess()):
            raise OSError(ctypes.get_last_error(), 'Cannot establish the sandbox job object')
        return job
    import resource
    for kind, value in ((resource.RLIMIT_AS, MEMORY), (resource.RLIMIT_CPU, 90), (resource.RLIMIT_FSIZE, 200 << 20),
                        (resource.RLIMIT_NPROC, 0), (resource.RLIMIT_NOFILE, 128)):
        try:
            _, hard = resource.getrlimit(kind)
            resource.setrlimit(kind, (value if hard == resource.RLIM_INFINITY else min(value, hard), hard))
        except (ValueError, OSError): pass
    return None


BLOCKED = ('socket.', 'subprocess.', 'os.system', 'os.exec', 'os.spawn', 'os.posix_spawn', 'os.fork', 'os.forkpty',
           'os.startfile', 'os.kill', 'os.putenv', 'os.unsetenv', 'os.chdir', 'os.add_dll_directory', 'ctypes.',
           '_winapi.', 'winreg.', 'msvcrt.', 'mmap.', 'gc.get_', 'sys._current_frames', 'urllib.', 'http.', 'ftplib.',
           'smtplib.', 'webbrowser.', 'pty.', 'resource.setrlimit', 'sys.remote_exec', 'code.interact', 'sqlite3.')
PATHS = {'open': 0, 'os.listdir': 0, 'os.scandir': 0, 'os.remove': 0, 'os.rmdir': 0, 'os.mkdir': 0, 'os.rename': 0,
         'os.replace': 0, 'os.link': 0, 'os.symlink': 0, 'os.truncate': 0, 'os.chmod': 0, 'os.chown': 0, 'os.utime': 0,
         'shutil.copyfile': 0, 'shutil.copytree': 0, 'shutil.move': 0, 'shutil.rmtree': 0, 'shutil.make_archive': 0,
         'glob.glob': 0, 'os.walk': 0, 'pathlib.Path.glob': 0, 'pathlib.Path.rglob': 0, 'zipfile.ZipFile': 0}
BAD_MODULES = {'ctypes', '_ctypes', 'socket', '_socket', 'ssl', '_ssl', 'subprocess', '_posixsubprocess', 'multiprocessing',
               '_multiprocessing', 'asyncio', 'select', 'selectors', 'mmap', 'winreg', '_winapi', 'msvcrt', 'pty', 'urllib.request',
               'http.client', 'sqlite3', '_sqlite3', 'cffi'}
BAD_TOP = {m for m in BAD_MODULES if '.' not in m}


def install_guard(workdir):
    workdir = os.path.realpath(workdir)
    readable = tuple({os.path.realpath(p) for p in (sys.prefix, sys.base_prefix, sys.exec_prefix, HERE,
                      *[p for p in sys.path if p and os.path.isdir(p)])})

    def inside(path, roots):
        try: real = os.path.realpath(os.fsdecode(path) if not isinstance(path, int) else '')
        except Exception: return False
        return any(real == r or real.startswith(r.rstrip(os.sep) + os.sep) for r in roots)

    def hook(event, args):
        if event.startswith(BLOCKED): raise PermissionError('Sandbox: %s is not available' % event)
        if event == 'import' and args and (str(args[0]) in BAD_MODULES or str(args[0]).split('.')[0] in BAD_TOP):
            raise PermissionError('Sandbox: importing %s is not available' % args[0])
        if event in PATHS and args:
            path = args[0]
            if isinstance(path, int) or path is None: return
            if isinstance(path, (str, bytes, os.PathLike)):
                if inside(path, (workdir,)): return
                write = event != 'open' or (len(args) > 1 and isinstance(args[1], str) and any(c in args[1] for c in 'wax+'))
                write = write or (event == 'open' and len(args) > 2 and isinstance(args[2], int) and args[2] & (os.O_WRONLY | os.O_RDWR | os.O_CREAT))
                if not write and event in ('open', 'os.listdir', 'os.scandir') and inside(path, readable): return
                raise PermissionError('Sandbox: file access outside the document directory is not available')
    for name in [m for m in list(sys.modules) if m.split('.')[0] in ('ctypes', '_ctypes')]:
        sys.modules.pop(name, None)
    sys.addaudithook(hook)


def load_document(path):
    import docx
    from docx.opc.part import PartFactory, XmlPart
    from docx.oxml.text.paragraph import CT_P
    from ooxml import accepted_text
    for ct in ('footnotes', 'endnotes'):
        PartFactory.part_type_for['application/vnd.openxmlformats-officedocument.wordprocessingml.%s+xml' % ct] = XmlPart
    CT_P.text = property(accepted_text)     # paragraph.text reads the accepted view in tracked documents
    return docx.Document(path)


def namespace(doc, mode):
    import copy, re, math, datetime   # noqa: E401  (offered to programs)
    from lxml import etree
    import docx
    from docx.enum.section import WD_ORIENT, WD_SECTION_START
    from docx.enum.style import WD_STYLE_TYPE
    from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_ROW_HEIGHT_RULE, WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_COLOR_INDEX, WD_LINE_SPACING, WD_TAB_ALIGNMENT, WD_UNDERLINE
    from docx.oxml import OxmlElement, parse_xml
    from docx.oxml.ns import nsdecls, qn
    from docx.shared import Cm, Emu, Inches, Mm, Pt, RGBColor, Twips
    import helpers
    helpers.DOC = doc
    names = {k: v for k, v in vars(helpers).items() if not k.startswith('_') and callable(v) and getattr(v, '__module__', '') == 'helpers'}
    names.update(dict(doc=doc, TRACKED=mode == 'tracked', etree=etree, docx=docx, copy=copy, re=re, math=math, datetime=datetime,
                      OxmlElement=OxmlElement, parse_xml=parse_xml, qn=qn, nsdecls=nsdecls, Pt=Pt, Mm=Mm, Cm=Cm, Inches=Inches,
                      Emu=Emu, Twips=Twips, RGBColor=RGBColor, WD_ORIENT=WD_ORIENT, WD_SECTION_START=WD_SECTION_START,
                      WD_STYLE_TYPE=WD_STYLE_TYPE, WD_ALIGN_PARAGRAPH=WD_ALIGN_PARAGRAPH, WD_BREAK=WD_BREAK,
                      WD_COLOR_INDEX=WD_COLOR_INDEX, WD_LINE_SPACING=WD_LINE_SPACING, WD_TAB_ALIGNMENT=WD_TAB_ALIGNMENT,
                      WD_UNDERLINE=WD_UNDERLINE, WD_TABLE_ALIGNMENT=WD_TABLE_ALIGNMENT, WD_ROW_HEIGHT_RULE=WD_ROW_HEIGHT_RULE,
                      WD_CELL_VERTICAL_ALIGNMENT=WD_CELL_VERTICAL_ALIGNMENT, Paragraph=helpers.Paragraph, Table=helpers.Table,
                      Run=helpers.Run, Section=__import__('docx.section', fromlist=['Section']).Section))
    return names


def compile_program(source):
    """A function body: `return` works at top level; line numbers stay the model's."""
    tree = ast.parse(source, '<program>')
    fn = ast.FunctionDef(name='program', args=ast.arguments(posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]),
                         body=tree.body or [ast.Pass()], decorator_list=[], returns=None)
    if 'type_params' in ast.FunctionDef._fields: fn.type_params = []
    module = ast.Module(body=[fn], type_ignores=[])
    ast.fix_missing_locations(module)
    return compile(module, '<program>', 'exec')


def story_roots(doc):
    roots = [doc.element.body]
    for part in doc.part.package.iter_parts():
        ct = part.content_type
        if hasattr(part, 'element') and ct.endswith(('.header+xml', '.footer+xml', '.footnotes+xml', '.endnotes+xml')):
            roots.append(part.element)
    return roots


def main():
    reply = sys.stdout
    captured = io.StringIO()
    try:
        request = json.loads(sys.stdin.readline(1 << 20))
        mode = request.get('mode')
        if mode not in ('tracked', 'direct', 'read-only'): raise ValueError('Unknown mode')
        job = limit_process()  # noqa: F841  (held for the process lifetime)
        sys.path.insert(0, HERE)
        doc = load_document('document.docx')
        code = compile_program(request['program'])
        names = namespace(doc, mode)
        import tracking
        recorder = tracking.Recorder(story_roots(doc)) if mode == 'tracked' else None
        install_guard(os.getcwd())
        sys.stdout = captured
        exec(code, names)
        result = names['program']()
        sys.stdout = reply
        output = captured.getvalue()
        warnings = recorder.record() if recorder else []
        if mode == 'tracked': names['track_revisions_on']()
        if mode != 'read-only': doc.save('candidate.docx')
        encoded = json.dumps(result, default=repr, ensure_ascii=False)
        if len(encoded) > 64000: encoded = json.dumps(repr(result)[:2000] + ' ... [result exceeds 64000 bytes; return a summary]')
        reply.write(json.dumps({'ok': True, 'result': json.loads(encoded), 'stdout': output[-20000:],
                                'stdout_truncated': len(output) > 20000, 'warnings': warnings}, ensure_ascii=False) + '\n')
    except BaseException as error:  # noqa: BLE001  report everything, including SystemExit from programs
        sys.stdout = reply
        frames = [f for f in traceback.extract_tb(error.__traceback__) if f.filename in ('<program>',) or f.filename.endswith(('helpers.py', 'tracking.py'))]
        where = '; '.join('%s line %d%s' % ('program' if f.filename == '<program>' else os.path.basename(f.filename), f.lineno,
                                           (': ' + f.line.strip()[:120]) if f.line else '') for f in frames[-3:])
        reply.write(json.dumps({'ok': False, 'error': ('%s: %s' % (type(error).__name__, error))[:1500] + (' [' + where + ']' if where else ''),
                                'stdout': captured.getvalue()[-4000:]}, ensure_ascii=False) + '\n')
    reply.flush()


if __name__ == '__main__':
    main()
