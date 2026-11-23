#!/usr/bin/env python3
"""Rebuild Realm-VC.apk with the Android assets in android/assets/.

The native shell (classes.dex) is unchanged. Assets are overlaid, the package
is zip-aligned, then signed. Pass the original release keystore to keep the
signature users already have installed:

    REALM_VC_KEYSTORE=/path/keystore.jks \\
    REALM_VC_STOREPASS=... REALM_VC_KEYALIAS=... \\
    python3 scripts/pack-apk.py

Without that, a local debug keystore under /tmp is used and Android will
refuse to install the APK over a copy signed with the previous key.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APK = os.path.join(ROOT, "Realm-VC.apk")
ASSETS = os.path.join(ROOT, "android", "assets")
ZIPALIGN = os.environ.get("ZIPALIGN", "/tmp/android-bt/android-14/zipalign")
APKSIGNER = os.environ.get("APKSIGNER", "/tmp/android-bt/android-14/apksigner")


def overlay_map():
    found = {}
    for name in os.listdir(ASSETS):
        path = os.path.join(ASSETS, name)
        if os.path.isfile(path):
            found["assets/" + name] = path
    if "assets/app.js" not in found or "assets/voice-guard.js" not in found:
        sys.exit("android/assets is missing app.js or voice-guard.js")
    return found


def rebuild_zip(src, dst, overlays):
    seen = set()
    with zipfile.ZipFile(src, "r") as zin, zipfile.ZipFile(dst, "w") as zout:
        for info in zin.infolist():
            seen.add(info.filename)
            data = open(overlays[info.filename], "rb").read() if info.filename in overlays else zin.read(info.filename)
            out = zipfile.ZipInfo(filename=info.filename, date_time=info.date_time)
            out.compress_type = info.compress_type
            out.external_attr = info.external_attr
            out.create_system = info.create_system
            out.flag_bits = info.flag_bits & ~0x1  # drop encryption flag if any
            zout.writestr(out, data)
        for arc, path in overlays.items():
            if arc in seen:
                continue
            out = zipfile.ZipInfo(filename=arc, date_time=(1981, 1, 1, 1, 1, 2))
            out.compress_type = zipfile.ZIP_DEFLATED
            zout.writestr(out, open(path, "rb").read())


def ensure_keystore():
    ks = os.environ.get("REALM_VC_KEYSTORE")
    if ks:
        return ks, os.environ["REALM_VC_STOREPASS"], os.environ.get("REALM_VC_KEYPASS", os.environ["REALM_VC_STOREPASS"]), os.environ.get("REALM_VC_KEYALIAS", "realmvc")
    ks = "/tmp/realmvc-dev.jks"
    store = "realmvc-dev"
    alias = "realmvc"
    if not os.path.exists(ks):
        subprocess.check_call([
            "keytool", "-genkeypair", "-keystore", ks,
            "-storepass", store, "-keypass", store, "-alias", alias,
            "-dname", "CN=Realm VC, O=Realm VC, C=US",
            "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000"
        ])
    return ks, store, store, alias


def main():
    overlays = overlay_map()
    tmp = tempfile.mkdtemp(prefix="realmvc-apk-")
    unsigned = os.path.join(tmp, "unsigned.apk")
    aligned = os.path.join(tmp, "aligned.apk")
    signed = os.path.join(tmp, "signed.apk")
    rebuild_zip(APK, unsigned, overlays)
    subprocess.check_call([ZIPALIGN, "-p", "-f", "4", unsigned, aligned])
    ks, store, key, alias = ensure_keystore()
    subprocess.check_call([
        APKSIGNER, "sign", "--ks", ks,
        "--ks-pass", "pass:" + store, "--key-pass", "pass:" + key,
        "--ks-key-alias", alias, "--out", signed, aligned
    ])
    subprocess.check_call([APKSIGNER, "verify", "--verbose", signed])
    shutil.copy2(signed, APK)
    # Confirm the shipped assets match the sources.
    with zipfile.ZipFile(APK) as z:
        for arc, path in overlays.items():
            packed = z.read(arc)
            disk = open(path, "rb").read()
            if packed != disk:
                sys.exit("packed %s does not match %s" % (arc, path))
    print("wrote", APK)


if __name__ == "__main__":
    main()
