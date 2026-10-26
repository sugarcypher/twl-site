#!/usr/bin/env python3
"""Build lucidlux.fyi/tapboom from the master tapboom.html.

The master is the artifact page (first line: a wrapper head; second: <title>;
last: </body></html>). The site copy gets the installable-app head, the shared
account script injected before the game, and the offline worker registration.
"""
import re, sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
master = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/home/claude/tapboom.html').read_text()
lines = master.split('\n')
assert lines[0].startswith('<!doctype html>'), 'unexpected wrapper line'
assert lines[1].strip() == '<title>TapBoom</title>', 'unexpected title line'
body = '\n'.join(lines[2:]).rstrip()
assert body.endswith('</body></html>'), 'unexpected tail'
body = body[: -len('</body></html>')].rstrip()
version = re.search(r"const VERSION = '([^']+)'", body).group(1)

head = (root / 'tools' / 'tapboom-head.html').read_text().rstrip()
account = (root / 'account' / 'lucidlux-account.js').read_text()
sw_reg = """<script>
// Offline install: cache the game so it runs from the home screen with no signal.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
}
</script>"""
page = head + '\n<script>\n' + account + '\n</script>\n' + body + '\n\n' + sw_reg + '\n</body>\n</html>\n'
(root / 'tapboom' / 'index.html').write_text(page)

sw = (root / 'tapboom' / 'sw.js').read_text()
sw = re.sub(r"const VERSION = '[^']+';", "const VERSION = 'tapboom-%s-1';" % version, sw)
(root / 'tapboom' / 'sw.js').write_text(sw)
print('built tapboom', version, len(page), 'bytes')
