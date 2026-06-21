"""生成 API 监听器插件图标 — SVG 转 PNG"""
import os, struct, zlib, math

def create_png(width, color):
    """创建纯色 PNG (RGBA)"""
    def chunk(chunk_type, data):
        c = chunk_type + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    raw = b''
    for y in range(height := width):
        raw += b'\x00'  # filter byte
        for x in range(width):
            raw += color  # RGBA

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n' +
        chunk(b'IHDR', ihdr) +
        chunk(b'IDAT', zlib.compress(raw)) +
        chunk(b'IEND', b'')
    )

def create_icon(width):
    """创建带天线的蓝牙图标 (抽象)"""
    im = []
    for _ in range(width * width):
        im.append((0, 0, 0, 0))  # 透明背景

    mid = width // 2
    # 绘制圆形天线
    for y in range(width):
        for x in range(width):
            dx, dy = x - mid, y - mid
            dist = math.sqrt(dx*dx + dy*dy)
            if dist < width * 0.35 and y > mid - 2:
                g = 255 if (x + y) % 4 < 2 else 180
                im[y * width + x] = (50, g, 220, 255)

    # 绘制天线
    ant_x = mid - width // 8
    ant_w = width // 4
    for y in range(int(width * 0.1), int(width * 0.5)):
        for x in range(ant_x, ant_x + ant_w):
            if mid - 2 <= x <= mid + 2 or (y < width * 0.35 and abs(x - mid) <= 4):
                im[y * width + x] = (255, 255, 255, 255)

    raw = b''
    for y in range(width):
        raw += b'\x00'
        for x in range(width):
            raw += bytes(im[y * width + x])

    ihdr = struct.pack('>IIBBBBB', width, width, 8, 6, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n' +
        chunk(b'IHDR', ihdr) +
        chunk(b'IDAT', zlib.compress(raw)) +
        chunk(b'IEND', b'')
    )

def chunk(chunk_type, data):
    c = chunk_type + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

# 生成 4 种尺寸
ICON_DIR = os.path.dirname(os.path.abspath(__file__)) + '/icons'
os.makedirs(ICON_DIR, exist_ok=True)

for size in [16, 32, 48, 128]:
    data = create_icon(size)
    path = ICON_DIR + '/icon' + str(size) + '.png'
    with open(path, 'wb') as f:
        f.write(data)
    print(f'Created {path} ({len(data)} bytes)')

# 也生成一个扩展图标 (圆形雷达)
radar_colors = [
    (50, 150, 250, 255),
    (100, 180, 100, 255),
    (240, 180, 50, 255),
    (220, 80, 80, 255),
]

# 生成更漂亮的雷达图标
def create_radar_icon(width):
    w = width
    im = [(0, 0, 0, 0)] * (w * w)
    mid = w // 2
    # 雷达扫掠
    for y in range(w):
        for x in range(w):
            dx, dy = x - mid, y - mid
            dist = math.sqrt(dx*dx + dy*dy)
            angle = math.atan2(-dy, dx)
            if angle < 0: angle += 2 * math.pi
            r_max = w * 0.42
            if dist < r_max:
                # 雷达扫掠效果
                sweep = (angle / (2*math.pi) * 8) % 4
                ci = int(sweep) % 4
                alpha = 100 + int(sweep % 1 * 100)
                if dist < r_max * 0.85:
                    c = radar_colors[ci]
                    im[y * w + x] = (c[0], c[1], c[2], min(255, alpha))
            # 中心点
            if dist < w * 0.06:
                im[y * w + x] = (255, 255, 255, 255)

    raw = b''
    for y in range(w):
        raw += b'\x00'
        for x in range(w):
            raw += bytes(im[y * w + x])
    ihdr = struct.pack('>IIBBBBB', w, w, 8, 6, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n' +
        chunk(b'IHDR', ihdr) +
        chunk(b'IDAT', zlib.compress(raw)) +
        chunk(b'IEND', b'')
    )

# 用雷达图标覆盖
for size in [16, 32, 48, 128]:
    data = create_radar_icon(size)
    path = ICON_DIR + '/icon' + str(size) + '.png'
    with open(path, 'wb') as f:
        f.write(data)
    print(f'Updated {path} ({len(data)} bytes)')

print('\nDone! All icons generated.')
