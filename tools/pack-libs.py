"""Pack haxelib sources the playground serves itself.

    python tools/pack-libs.py

Writes one assets/libs/<name>.json per library, taken from whatever version
`haxelib libpath` reports, plus assets/libs/index.json listing them. A project
gets one with `-lib <name>` in its build.hxml (or, for Feathers UI, just by
importing feathers.*); dependencies named in haxelib.json are pulled in the same
way. Each compiler instance writes a library under /libs/<name> once. OpenFL and
Lime are not here: they are already packed into hxc.data.

Each library's license file is included and written next to its sources, and
its extraParams.hxml, if any, is applied wherever it is used.

Workaround, remove once the playground's compiler is rebuilt with the fix: hxc's
macro encoder writes an empty `default:` as no default at all, so a switch in a
class that goes through a build macro (every Feathers UI control does) loses
it and fails with "Unmatched patterns". The packed copies spell those defaults
`default: {}`, which means the same thing and survives the round trip.
"""

import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBS = ["feathersui", "actuate"]

EMPTY_DEFAULT = re.compile(r"default:(\s*\n\s*\})")


def libpath(name):
    out = subprocess.run(["haxelib", "libpath", name], capture_output=True, text=True, check=True)
    return out.stdout.strip().splitlines()[-1].strip()


def pack(name):
    base = libpath(name)
    meta = json.load(open(os.path.join(base, "haxelib.json"), encoding="utf-8"))
    src = os.path.join(base, meta.get("classPath", ""))
    files = {}
    for dirpath, _, names in os.walk(src):
        for n in sorted(names):
            if n.endswith(".hx"):
                full = os.path.join(dirpath, n)
                rel = os.path.relpath(full, src).replace(os.sep, "/")
                files[rel] = EMPTY_DEFAULT.sub(r"default: {}\1", open(full, encoding="utf-8").read())
    for lic in ("LICENSE.md", "LICENSE.txt", "LICENSE"):
        p = os.path.join(base, lic)
        if os.path.exists(p):
            files[lic] = open(p, encoding="utf-8").read()
            break
    extra = os.path.join(base, "extraParams.hxml")
    return {
        "name": name,
        "version": meta["version"],
        "license": meta.get("license", ""),
        "dependencies": meta.get("dependencies", {}),
        "extraParams": open(extra, encoding="utf-8").read() if os.path.exists(extra) else "",
        "files": files,
    }


def main():
    out_dir = os.path.join(ROOT, "assets", "libs")
    os.makedirs(out_dir, exist_ok=True)
    index = {}
    for name in LIBS:
        lib = pack(name)
        out = os.path.join(out_dir, name + ".json")
        with open(out, "w", encoding="utf-8", newline="\n") as f:
            json.dump({"libs": [lib]}, f, separators=(",", ":"))
        index[name] = {"version": lib["version"], "license": lib["license"]}
        print("%s: %s %s, %d files, %d bytes" % (os.path.relpath(out, ROOT), name, lib["version"],
                                                len(lib["files"]), os.path.getsize(out)))
    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(index, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    sys.exit(main())
