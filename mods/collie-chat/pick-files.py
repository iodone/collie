#!/usr/bin/env python3
# The desktop's own file picker, several files at once, for the chat's attach button: prints each chosen path on its own
# line; nothing when cancelled. macOS asks through osascript; Linux through xdg-desktop-portal (herdr's mods have a folder
# picker only, so the chat runs this).
# Ported from shepherdr's chat pick-files.py (Wayland's portal), with the macOS half added for Collie.
import sys

title = sys.argv[1] if len(sys.argv) > 1 else "Attach files"


def macos():
    import json
    import subprocess

    # AppleScript's strings take double quotes: json.dumps quotes and escapes them the same way.
    script = (
        'set theFiles to choose file with prompt ' + json.dumps(title) + ' with multiple selections allowed\n'
        'set out to ""\n'
        'repeat with f in theFiles\n'
        'set out to out & POSIX path of f & linefeed\n'
        'end repeat\n'
        'return out'
    )
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=600)
    except Exception:
        return []
    return [l for l in r.stdout.splitlines() if l.strip()]


def portal():
    from urllib.parse import unquote, urlparse

    from gi.repository import Gio, GLib

    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    token = f"collie_chat_{GLib.random_int()}"
    sender = bus.get_unique_name()[1:].replace(".", "_")
    path = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
    loop = GLib.MainLoop()
    chosen = []

    def response(_bus, _sender, _path, _iface, _signal, params):
        code, results = params.unpack()
        if code == 0:
            for uri in results.get("uris", []):
                u = urlparse(uri)
                if u.scheme == "file":
                    chosen.append(unquote(u.path))
        loop.quit()

    # Listen before asking, so the answer can't come first.
    bus.signal_subscribe("org.freedesktop.portal.Desktop", "org.freedesktop.portal.Request", "Response",
                         path, None, Gio.DBusSignalFlags.NONE, response)
    bus.call_sync("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
                  "org.freedesktop.portal.FileChooser", "OpenFile",
                  GLib.Variant("(ssa{sv})", ("", title, {
                      "handle_token": GLib.Variant("s", token),
                      "multiple": GLib.Variant("b", True),
                      "accept_label": GLib.Variant("s", "Attach"),
                  })), GLib.VariantType("(o)"), Gio.DBusCallFlags.NONE, -1, None)
    loop.run()
    return chosen


chosen = macos() if sys.platform == "darwin" else portal()
print("\n".join(chosen))
