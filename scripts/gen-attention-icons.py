#!/usr/bin/env python3
"""Generate a consuming app's attention-icon variants: its favicon with one small
status dot composited top-right.

The browser tab icon is one of three surfaces the tabs feature paints when a
BACKGROUND session wants the user (see features/tabs/attention.ts). It swaps each
`link[rel=icon]` to a pre-rendered variant, so the variants have to exist as real
files: a runtime canvas composite was the alternative and it puts a rasteriser on
the critical path of every status sweep.

Dependency-free on purpose. There is no rasteriser in the dev container and this
is a maintainer tool run on a theme change, not a build step, so it carries its
own minimal PNG codec rather than adding Pillow to anyone's toolchain. The base
icon is DECODED and composited rather than redrawn, so a variant is the app's own
icon pixel-for-pixel plus a dot.

The dot colour is derived from the app's `--status-*` theme token, in the same
colour space the CSS declares it in, so a variant cannot drift from the tab dot
it mirrors. Change a theme token, re-run this.

Usage:
    python3 scripts/gen-attention-icons.py --app web-terminal-kiro --static ../web-terminal-kiro/static
    python3 scripts/gen-attention-icons.py --app web-terminal-server --static ../web-terminal-server/static
    python3 scripts/gen-attention-icons.py --app vibekit --static ../vibekit/static
    python3 scripts/gen-attention-icons.py --app all --root ..        # every app, sibling checkouts
"""

from __future__ import annotations

import argparse
import math
import pathlib
import re
import struct
import sys
import zlib

# ---------------------------------------------------------------------------
# Geometry, in the icons' own 32-unit viewBox. Every output size scales from it.
#
# The dot sits in the top-right quadrant, which is empty in both apps' icons (the
# chevron occupies x 8-14 / y 11-21 and the underscore y 22). PAD is clear space
# above and right of the dot, so it reads as a badge ON the icon rather than a
# corner that bled off it. r=5.5 is the smallest radius still legible at 16px,
# where the whole dot is 5.5px across.
DOT_R = 5.5
PAD = 3.0
DOT_CX = 32.0 - PAD - DOT_R
DOT_CY = PAD + DOT_R

# Supersampling factor per axis for the dot's edge. 4x4 is indistinguishable from
# exact coverage at these sizes and needs no analytic circle-pixel intersection.
SS = 4


# ---------------------------------------------------------------------------
# Colour. The apps declare status tokens in two notations: web-terminal-kiro uses
# oklch() for the family it themes, web-terminal-server takes the library's sRGB
# hex defaults. Both are resolved here to the sRGB hex a PNG and an SVG fill need.


def _srgb_encode(c: float) -> float:
    """Linear-light channel to sRGB-encoded, per IEC 61966-2-1."""
    if c <= 0.0031308:
        return 12.92 * c
    return 1.055 * (c ** (1 / 2.4)) - 0.055


def oklch_to_hex(lightness: float, chroma: float, hue_deg: float) -> str:
    """oklch() to an sRGB hex string, gamut-clamped per channel.

    The same conversion a browser performs for `oklch(78% 0.15 95deg)`. Matrices
    are Bjorn Ottosson's Oklab definition. A channel outside sRGB is CLAMPED, not
    gamut-mapped: web-terminal-kiro's own theme comment records that the greens
    and yellows it uses are in gamut, and its out-of-gamut violet is already
    pinned as an explicit hex for exactly this reason, so clamping cannot silently
    change a shipped colour here.
    """
    hue = math.radians(hue_deg)
    a = chroma * math.cos(hue)
    b = chroma * math.sin(hue)

    l_ = lightness + 0.3963377774 * a + 0.2158037573 * b
    m_ = lightness - 0.1055613458 * a - 0.0638541728 * b
    s_ = lightness - 0.0894841775 * a - 1.2914855480 * b

    l, m, s = l_**3, m_**3, s_**3

    lin = (
        +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    )
    out = []
    for channel in lin:
        v = _srgb_encode(max(0.0, min(1.0, channel)))
        out.append(max(0, min(255, round(v * 255))))
    return f'#{out[0]:02x}{out[1]:02x}{out[2]:02x}'


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    text = value.lstrip('#')
    if len(text) != 6:
        raise ValueError(f'expected a 6-digit hex colour, got {value!r}')
    return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))


# ---------------------------------------------------------------------------
# Minimal PNG codec. Reads what the two apps actually ship (kiro: 8-bit RGBA;
# server: 16-bit grey+alpha) and normalises to 8-bit RGBA, which is also what it
# writes, so every variant has one predictable format whatever the base was.

_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


def _unfilter(raw: bytes, width: int, height: int, channels: int, depth: int) -> bytearray:
    sample_bytes = depth // 8
    stride = width * channels * sample_bytes
    step = max(1, channels * sample_bytes)
    out = bytearray(stride * height)
    pos = 0
    for y in range(height):
        method = raw[pos]
        pos += 1
        row = bytearray(raw[pos : pos + stride])
        pos += stride
        prev = out[(y - 1) * stride : y * stride] if y else bytes(stride)
        if method == 1:
            for i in range(step, stride):
                row[i] = (row[i] + row[i - step]) & 0xFF
        elif method == 2:
            for i in range(stride):
                row[i] = (row[i] + prev[i]) & 0xFF
        elif method == 3:
            for i in range(stride):
                left = row[i - step] if i >= step else 0
                row[i] = (row[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif method == 4:
            for i in range(stride):
                a = row[i - step] if i >= step else 0
                b = prev[i]
                c = prev[i - step] if i >= step else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                row[i] = (row[i] + pred) & 0xFF
        elif method != 0:
            raise ValueError(f'unsupported PNG row filter {method}')
        out[y * stride : (y + 1) * stride] = row
    return out


def png_decode(data: bytes) -> tuple[int, int, bytearray]:
    """Decode a non-interlaced PNG to (width, height, 8-bit RGBA bytes)."""
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('not a PNG')
    width = height = depth = colortype = 0
    idat = bytearray()
    off = 8
    while off < len(data):
        length = struct.unpack('>I', data[off : off + 4])[0]
        kind = data[off + 4 : off + 8]
        body = data[off + 8 : off + 8 + length]
        if kind == b'IHDR':
            width, height, depth, colortype, _, _, interlace = struct.unpack('>IIBBBBB', body)
            if interlace:
                raise ValueError('interlaced PNG is not supported')
            if colortype == 3:
                raise ValueError('palette PNG is not supported')
            if depth not in (8, 16):
                raise ValueError(f'unsupported bit depth {depth}')
        elif kind == b'IDAT':
            idat += body
        elif kind == b'IEND':
            break
        off += 12 + length

    channels = _CHANNELS[colortype]
    rows = _unfilter(zlib.decompress(bytes(idat)), width, height, channels, depth)
    stride_samples = width * channels
    skip = depth // 8  # 16-bit: keep the high byte, which is the value to 1/257
    rgba = bytearray(width * height * 4)
    for i in range(width * height):
        base = (i // width) * stride_samples * skip + (i % width) * channels * skip
        s = [rows[base + c * skip] for c in range(channels)]
        if colortype == 0:
            r = g = b = s[0]
            a = 255
        elif colortype == 4:
            r = g = b = s[0]
            a = s[1]
        elif colortype == 2:
            r, g, b = s
            a = 255
        else:
            r, g, b, a = s
        rgba[i * 4 : i * 4 + 4] = bytes((r, g, b, a))
    return width, height, rgba


def png_encode(width: int, height: int, rgba: bytes) -> bytes:
    """Encode 8-bit RGBA as a PNG, choosing the cheapest row filter per row."""
    stride = width * 4
    raw = bytearray()
    for y in range(height):
        row = rgba[y * stride : (y + 1) * stride]
        prev = rgba[(y - 1) * stride : y * stride] if y else bytes(stride)
        best = None
        for method in (0, 1, 2, 3, 4):
            enc = bytearray()
            for i in range(stride):
                a = row[i - 4] if i >= 4 else 0
                b = prev[i]
                c = prev[i - 4] if i >= 4 else 0
                if method == 0:
                    v = row[i]
                elif method == 1:
                    v = row[i] - a
                elif method == 2:
                    v = row[i] - b
                elif method == 3:
                    v = row[i] - ((a + b) >> 1)
                else:
                    p = a + b - c
                    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                    pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                    v = row[i] - pred
                enc.append(v & 0xFF)
            cost = sum(min(v, 256 - v) for v in enc)
            if best is None or cost < best[0]:
                best = (cost, method, enc)
        raw.append(best[1])
        raw += best[2]

    def chunk(kind: bytes, body: bytes) -> bytes:
        return (
            struct.pack('>I', len(body))
            + kind
            + body
            + struct.pack('>I', zlib.crc32(kind + body) & 0xFFFFFFFF)
        )

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', ihdr)
        + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
        + chunk(b'IEND', b'')
    )


# ---------------------------------------------------------------------------
# Compositing


def paint_dot(width: int, height: int, rgba: bytearray, colour: tuple[int, int, int]) -> bytearray:
    """Composite the status dot onto an 8-bit RGBA buffer, source-over.

    Geometry scales from the 32-unit viewBox, so a 16px icon gets a
    proportionally placed dot rather than a differently-designed one.
    """
    if width != height:
        raise ValueError(f'expected a square icon, got {width}x{height}')
    scale = width / 32.0
    cx, cy, r = DOT_CX * scale, DOT_CY * scale, DOT_R * scale
    sr, sg, sb = colour
    out = bytearray(rgba)
    # Only the dot's bounding box can change.
    x0, x1 = max(0, int(cx - r) - 1), min(width, int(cx + r) + 2)
    y0, y1 = max(0, int(cy - r) - 1), min(height, int(cy + r) + 2)
    for y in range(y0, y1):
        for x in range(x0, x1):
            hits = 0
            for sy in range(SS):
                py = y + (sy + 0.5) / SS
                for sx in range(SS):
                    px = x + (sx + 0.5) / SS
                    if (px - cx) ** 2 + (py - cy) ** 2 <= r * r:
                        hits += 1
            if not hits:
                continue
            alpha = hits / (SS * SS)
            i = (y * width + x) * 4
            dr, dg, db, da = out[i], out[i + 1], out[i + 2], out[i + 3]
            da_f = da / 255.0
            out_a = alpha + da_f * (1.0 - alpha)
            if out_a <= 0:
                continue
            for offset, (s, d) in enumerate(((sr, dr), (sg, dg), (sb, db))):
                blended = (s * alpha + d * da_f * (1.0 - alpha)) / out_a
                out[i + offset] = max(0, min(255, round(blended)))
            out[i + 3] = max(0, min(255, round(out_a * 255)))
    return out


_VIEWBOX = re.compile(r'viewBox\s*=\s*"\s*([-\d.]+)\s+([-\d.]+)\s+([\d.]+)\s+([\d.]+)\s*"')


def svg_scale(source: str) -> float:
    """The factor mapping the 32-unit geometry above onto this SVG's own space.

    The geometry constants are declared in a 32-unit viewBox because that is what
    the two web-terminal icons use, and the PNG path already scales from it
    (paint_dot: `width / 32.0`). An SVG base with a different viewBox needs the
    same treatment or the dot lands mid-artwork at the wrong relative size —
    silently, since an SVG has no pixel grid to disagree with. A missing or
    non-square viewBox raises for the same reason paint_dot refuses a non-square
    PNG: the dot's placement is only meaningful in a square frame.
    """
    match = _VIEWBOX.search(source)
    if not match:
        raise ValueError('source SVG has no viewBox, so the dot cannot be placed')
    width, height = float(match.group(3)), float(match.group(4))
    if width <= 0 or width != height:
        raise ValueError(f'expected a square viewBox, got {width}x{height}')
    return width / 32.0


def svg_variant(source: str, hex_colour: str) -> str:
    """Insert the dot into the source SVG. Appended last so it paints on top."""
    if '</svg>' not in source:
        raise ValueError('source SVG has no closing tag')
    scale = svg_scale(source)
    cx, cy, r = DOT_CX * scale, DOT_CY * scale, DOT_R * scale
    circle = f'<circle cx="{cx:g}" cy="{cy:g}" r="{r:g}" fill="{hex_colour}"/>'
    head, _, tail = source.rpartition('</svg>')
    return head + circle + '</svg>' + tail


# ---------------------------------------------------------------------------
# Per-app configuration.
#
# One entry per cue status that CAN raise the icon. `crashed` and `failed` both
# render --status-failed, so they share one asset named `alert`; the tabs feature
# maps both onto it. `working` and `warning` are absent on purpose: they are
# ongoing and informational, so they raise no cue at all (see model.ts CueStatus).

# The base icons a variant is generated from. Every `link[rel=icon]` in the two
# web-terminal apps' index.html points at one of these three, and the swap
# replaces like with like so no link's `type` attribute has to change. The PWA
# icons (apple-touch-icon, icon-192x192, icon-512x512) are deliberately NOT here:
# those come from the manifest and are cached by the OS at install time, so a swap
# cannot reach them.
BASES = ('favicon.svg', 'favicon-32x32.png', 'favicon-16x16.png')

# `bases` is per app rather than global because it is derived from an app's OWN
# markup: the set has to be exactly the files its `link[rel~="icon"]` elements
# point at. A base an app does not ship is a hard error (see generate), which is
# the guard that catches a renamed icon — so an app with one icon link declares
# one base rather than being handed three and excused two.
APPS: dict[str, dict[str, object]] = {
    # static-src/app.ts themes these two in oklch; --status-failed keeps the
    # library default from css/00-tokens.css.
    'web-terminal-kiro': {
        'colours': {
            'input': oklch_to_hex(0.78, 0.15, 95),
            'done': oklch_to_hex(0.78, 0.15, 150),
            'alert': '#dc2626',
        },
        'bases': BASES,
    },
    # No theme overrides: the library defaults from css/00-tokens.css.
    'web-terminal-server': {
        'colours': {
            'input': '#fb923c',
            'done': '#22c55e',
            'alert': '#dc2626',
        },
        'bases': BASES,
    },
    # vibekit has no --status-* family, so the colours come from the vocabulary
    # its tab dots already use (static-src/css/01-tokens.css, the default theme's
    # :root values): --c-yellow is the waiting/permission dot, so it is `input`;
    # --c-green and --c-red carry done and alert. One icon serves both themes, so
    # the light-theme overrides below the fold are deliberately not read.
    #
    # ONE base: static/index.html has a single `link[rel="icon"]`, the SVG. Its
    # viewBox is 48, not 32 — svg_scale handles that.
    'vibekit': {
        'colours': {
            'input': oklch_to_hex(0.919, 0.07, 86.5),
            'done': oklch_to_hex(0.858, 0.109, 142.7),
            'alert': oklch_to_hex(0.756, 0.13, 2.8),
        },
        'bases': ('favicon.svg',),
    },
}


def variant_name(base: str, status: str) -> str:
    stem, dot, ext = base.partition('.')
    # favicon-32x32.png -> favicon-input-32x32.png; favicon.svg -> favicon-input.svg
    prefix, dash, rest = stem.partition('-')
    tail = f'-{rest}' if dash else ''
    return f'{prefix}-{status}{tail}{dot}{ext}'


def generate(app: str, static: pathlib.Path) -> int:
    colours: dict[str, str] = APPS[app]['colours']  # type: ignore[assignment]
    bases: tuple[str, ...] = APPS[app]['bases']  # type: ignore[assignment]
    written = 0
    for base in bases:
        source = static / base
        if not source.exists():
            raise SystemExit(f'{app}: missing base icon {source}')
        for status, hex_colour in colours.items():
            target = static / variant_name(base, status)
            if base.endswith('.svg'):
                target.write_text(svg_variant(source.read_text(), hex_colour), encoding='utf-8')
            else:
                width, height, rgba = png_decode(source.read_bytes())
                painted = paint_dot(width, height, rgba, hex_to_rgb(hex_colour))
                target.write_bytes(png_encode(width, height, bytes(painted)))
            written += 1
            print(f'  {target.name:34s} {hex_colour}  {target.stat().st_size:>6d} B')
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', required=True, choices=[*APPS, 'all'])
    parser.add_argument('--static', type=pathlib.Path, help="the app's static/ directory")
    parser.add_argument(
        '--root', type=pathlib.Path, help='parent of the app checkouts, for --app all'
    )
    args = parser.parse_args()

    targets: list[tuple[str, pathlib.Path]] = []
    if args.app == 'all':
        if not args.root:
            parser.error('--app all needs --root')
        targets = [(name, args.root / name / 'static') for name in APPS]
    else:
        if not args.static:
            parser.error('--app needs --static')
        targets = [(args.app, args.static)]

    total = 0
    for name, static in targets:
        print(f'{name} ({static}):')
        total += generate(name, static)
    print(f'{total} files written')
    return 0


if __name__ == '__main__':
    sys.exit(main())
