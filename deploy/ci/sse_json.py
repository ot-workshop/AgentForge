#!/usr/bin/env python3
"""Parse an SSE byte stream per the EventSource standard into event objects.
Frames end at a blank line; `data:` lines are joined with "\n"; each combined
data field is JSON.parse'd and must BE the event object (not wrapped)."""
import sys, json

def iter_frames(path):
    data = []
    with open(path, "rb") as f:
        for raw in f:
            line = raw.rstrip(b"\r\n")
            if line == b"":
                if data:
                    yield b"\n".join(data).decode()
                    data = []
                continue
            if line.startswith(b":") or not line:
                continue
            field, _, value = line.partition(b":")
            if value.startswith(b" "):
                value = value[1:]
            if field == b"data":
                data.append(value)
    if data:
        yield b"\n".join(data).decode()

def main(path, mode="list"):
    """strict: any unparsable frame that is followed by more frames is an error.
    A tail frame cut off by close/--max-time is dropped but reported on stderr."""
    out, offset, bad = [], 0, 0
    for chunk in iter_frames(path):
        try:
            obj = json.loads(chunk)
        except json.JSONDecodeError as e:
            bad += 1
            print("bad frame near offset %d (parsed %d frames): %s" % (offset, len(out), e),
                  file=sys.stderr)
            break
        assert isinstance(obj, dict) and "seq" in obj, "data is not the event object itself"
        out.append(obj)
        offset += 1
    if bad:
        sys.exit(3)
    if mode == "count":
        print(len(out))
    else:
        for o in out:
            print(json.dumps(o, ensure_ascii=False, sort_keys=True))
main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "list")
