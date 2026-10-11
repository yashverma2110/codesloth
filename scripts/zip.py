import os, zipfile
src = os.path.join(os.path.dirname(__file__), "..", "dist")
dst = "/workspace/codesloth.zip"
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(src):
        for f in sorted(files):
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, src))
print("wrote", dst, os.path.getsize(dst), "bytes")
