#!/usr/bin/env python3
"""
Generates the app icon as a PNG, with no image library.

Committed as a generator rather than a binary so the mark can be changed by editing
numbers instead of by opening a design tool nobody has. It is a placeholder: a page on
a dark ground, which reads at 16px because it is three shapes and two colours.

    python3 tooling/icon/make-icon.py src-tauri/icons/icon.png 512
"""
import struct
import sys
import zlib

INK = (0x24, 0x20, 0x1C)
PARCHMENT = (0xF4, 0xEF, 0xE3)
RULE = (0xC9, 0xBE, 0xA6)


def rounded(x, y, left, top, right, bottom, radius):
    """True when (x, y) is inside a rounded rectangle."""
    if not (left <= x < right and top <= y < bottom):
        return False
    for cx, cy in ((left + radius, top + radius), (right - radius, top + radius),
                   (left + radius, bottom - radius), (right - radius, bottom - radius)):
        inside_x = x < left + radius or x >= right - radius
        inside_y = y < top + radius or y >= bottom - radius
        if inside_x and inside_y:
            near = abs(x - cx) <= radius and abs(y - cy) <= radius
            if near and (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2:
                return False
    return True


def pixel(x, y, size):
    unit = size / 512
    if not rounded(x, y, 0, 0, size, size, int(96 * unit)):
        return None  # transparent outside the squircle
    page_l, page_t = int(112 * unit), int(88 * unit)
    page_r, page_b = int(400 * unit), int(424 * unit)
    if not rounded(x, y, page_l, page_t, page_r, page_b, int(16 * unit)):
        return INK
    # Ruled lines, suggesting prose rather than spelling anything.
    for index, width in enumerate((0.78, 0.86, 0.62, 0.86, 0.80, 0.44)):
        top = page_t + int((48 + index * 52) * unit)
        if top <= y < top + int(14 * unit):
            if page_l + int(36 * unit) <= x < page_l + int((page_r - page_l - 72 * unit) * width):
                return RULE
    return PARCHMENT


def write_png(path, size):
    rows = []
    for y in range(size):
        row = bytearray([0])  # filter type 0
        for x in range(size):
            colour = pixel(x, y, size)
            row.extend((0, 0, 0, 0) if colour is None else (*colour, 255))
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">2I5B", size, size, 8, 6, 0, 0, 0)
    with open(path, "wb") as out:
        out.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
                  + chunk(b"IDAT", raw) + chunk(b"IEND", b""))


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "src-tauri/icons/icon.png"
    edge = int(sys.argv[2]) if len(sys.argv) > 2 else 512
    write_png(target, edge)
    print(f"wrote {target} at {edge}x{edge}")
