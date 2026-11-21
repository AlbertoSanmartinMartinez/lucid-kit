# SPDX-License-Identifier: Apache-2.0
"""What the mutation checks of this directory share.

A mutation is one change to the code that takes a defence away: a check removed, a condition
loosened, a hash left out. Each is tried by itself: the file is changed, the tests that should
notice are run, and the file is put back. If the tests still pass, nothing was watching that
defence ("MISSED"), which means a test is missing, or the line did nothing.

A mutation is (file, text as it is, text to put in its place, what it stands for) and, for one
that needs other tests than the rest of its script, the list of those. The text has to be in the
file exactly once: code that has moved on since the mutation was written shows as "NOT FOUND",
and the mutation has to be written again against the code as it is.

The files of the repository are changed in place while this runs. Run one script at a time, and
nothing else that reads the code meanwhile.
"""
import os
import signal
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def run(mutations, tests, test_timeout_ms=30000):
    """Tries each mutation, or those whose description has the text given on the command line.

    Ends with 0 only if every one of them was caught.
    """
    only = sys.argv[1] if len(sys.argv) > 1 else None
    # Told to stop, it stops as from an error, so that the file being tried is put back first.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    tried = 0
    wrong = 0
    for path, old, new, label, *own in mutations:
        if only and only not in label:
            continue
        tried += 1
        file = os.path.join(ROOT, path)
        with open(file, encoding='utf-8') as handle:
            source = handle.read()
        if source.count(old) != 1:
            print(f'NOT FOUND {label} ({source.count(old)} places in {path})', flush=True)
            wrong += 1
            continue
        with open(file, 'w', encoding='utf-8') as handle:
            handle.write(source.replace(old, new))
        try:
            command = ['node', '--test', f'--test-timeout={test_timeout_ms}', *(own[0] if own else tests)]
            try:
                caught = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=600).returncode != 0
            except subprocess.TimeoutExpired:
                caught = True  # tests that never end have noticed too
        finally:
            with open(file, 'w', encoding='utf-8') as handle:
                handle.write(source)
        print(('caught    ' if caught else 'MISSED    ') + label, flush=True)
        wrong += 0 if caught else 1
    print(f'RESULT: {tried - wrong} of {tried} mutations caught', flush=True)
    sys.exit(1 if wrong else 0)
