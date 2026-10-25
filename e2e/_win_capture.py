#!/usr/bin/env python3
"""e2e/_win_capture.py — 帧级取证：按 PID 录窗口（固定 60fps），逐帧判"画面有没有缩"。

为什么必须这样录，而不是用 macOS 自带录屏：
  1. `screencapture -v` 是**变帧率编码**（实测 ~28.7fps），50ms 的闪现会被整段丢掉。
     2026-10-25 连续四轮"录不到"页面缩成 1/4 的那一帧，就是踩在这上面。
  2. 裁切坐标不能写死：窗口一动，`-R` 就拍到别的东西，得到的是**假阴性**。
     所以先按 pid 查 Quartz 实时 rect，按屏幕 backing scale 换算成像素再裁。

两个子命令（由 e2e/flicker_ws.cjs 调用，也可单独取证）：

    python3 e2e/_win_capture.py record  <pid> <seconds> <out.mov>
        → 录整屏（avfoundation，60fps CFR），逐行打印 JSON：
          {"rect":[x,y,w,h],"scale":2,"device":2} / {"recording":true} / {"crop":"W:H:X:Y"}
    python3 e2e/_win_capture.py analyze <mov> <crop> [frames_dir]
        → 按 60fps 解帧 + 裁切 + 统计，打印 JSON：
          {"frames":N,"tiny":[[frame,content_w_pct],...],"ink_min":..,"ink_max":..}
    python3 e2e/_win_capture.py probe
        → 依赖自检，打印 {"ok":true,"numpy":..,"device":2}

退出码：0 成功；2 找不到窗口；3 窗口不在屏幕上；4 依赖缺失。
"""
import sys, json, subprocess, glob, os, shutil, re
import Quartz


def screen_device():
    """avfoundation 里 screen 的索引不是固定的（这台机器是 2，换机器可能变）。
    每次现查，别写死 —— 写死会让套件在别人机器上拍到摄像头。"""
    env = os.environ.get('AIB_SCREEN_DEV')
    if env:
        return int(env)
    try:
        r = subprocess.run(['ffmpeg', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
                           capture_output=True, text=True, timeout=20)
        for line in (r.stderr or '').splitlines():
            m = re.search(r'\[(\d+)\]\s*(.+)$', line)
            if m and 'Capture screen' in m.group(2):
                return int(m.group(1))
    except Exception:
        pass
    return 2


def window_rect(pid):
    wl = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID
    )
    for w in wl:
        if int(w.get('kCGWindowOwnerPID', 0)) != pid:
            continue
        if w.get('kCGWindowLayer') != 0:
            continue
        b = w.get('kCGWindowBounds')
        if not b or int(b['Height']) < 200:
            continue
        return (int(b['X']), int(b['Y']), int(b['Width']), int(b['Height']),
                bool(w.get('kCGWindowIsOnscreen')))
    return None


def video_size(mov):
    """录制出来的真实像素尺寸。**不能靠猜**：这台机器的 CGDisplayPixelsWide 返回
    1470（逻辑点），而 avfoundation 实际录到 2940×1912（2×）—— 第一版按 1 倍换算，
    裁切整整偏到左上角四分之一，量出来的比例全是垃圾。"""
    try:
        r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                            '-show_entries', 'stream=width,height', '-of', 'csv=p=0', mov],
                           capture_output=True, text=True, timeout=20)
        w, h = (r.stdout or '').strip().split(',')[:2]
        return int(w), int(h)
    except Exception:
        return None


def display_width_pt():
    try:
        return Quartz.CGDisplayBounds(Quartz.CGMainDisplayID()).size.width
    except Exception:
        return 1470.0


def content_crop(win, view, off_y, vw, vh):
    """把「窗口矩形 + 视图矩形 + 内容区偏移」换算成裁切串。

    view / off_y 来自 App 自己的 `ui.window_bounds`（`view.getBounds()` 与
    `contentBounds.y - bounds.y`），所以不用猜标题栏/tab 栏高度 —— 猜 28+74 那版
    在真机上直接错位，量到的是隔壁窗口。
    """
    scale = vw / display_width_pt()
    x = (win[0] + view['x']) * scale
    y = (win[1] + off_y + view['y']) * scale
    w = view['width'] * scale
    h = view['height'] * scale
    # 夹进画面里：窗口贴底时底边会超出去，ffmpeg 会报错或悄悄变形
    w = max(16, min(w, vw - x))
    h = max(16, min(h, vh - y))
    return f'{int(w)}:{int(h)}:{int(x)}:{int(y)}', round(scale, 3)


def cmd_record(pid, secs, out, geom=None):
    if not shutil.which('ffmpeg'):
        print('MISSING_FFMPEG')
        return 4
    r = window_rect(pid)
    if not r:
        print('NO_WINDOW')
        return 2
    x, y, w, h, onscreen = r
    dev = screen_device()
    print(json.dumps({'rect': [x, y, w, h], 'onscreen': onscreen, 'device': dev}), flush=True)
    if not onscreen:
        print('NOT_ONSCREEN', flush=True)
        return 3
    print(json.dumps({'recording': True}), flush=True)
    subprocess.run(
        ['ffmpeg', '-y', '-loglevel', 'error',
         '-f', 'avfoundation', '-framerate', '60', '-i', str(dev),
         '-t', str(int(secs) + 1), '-c:v', 'libx264', '-preset', 'ultrafast',
         '-crf', '16', '-pix_fmt', 'yuv420p', out],
        check=False,
    )
    sz = video_size(out)
    if not sz:
        print(json.dumps({'error': 'no-video'}))
        return 5
    vw, vh = sz
    if geom and geom.get('view'):
        crop, scale = content_crop((x, y, w, h), geom['view'], geom.get('offsetY', 0), vw, vh)
    else:
        # 没有 App 几何时退回"跳过 chrome"的粗估（28 标题栏 + 74 tab/地址栏）
        scale = vw / display_width_pt()
        crop = (f'{int(w * scale)}:{int((h - 102) * scale)}:'
                f'{int(x * scale)}:{int((y + 102) * scale)}')
    print(json.dumps({'crop': crop, 'scale': scale, 'video': [vw, vh]}), flush=True)
    return 0


def cmd_probe():
    try:
        import numpy
        from PIL import Image  # noqa: F401
    except Exception as e:
        print(json.dumps({'ok': False, 'reason': 'MISSING_PIL', 'detail': str(e)}))
        return 4
    if not shutil.which('ffmpeg'):
        print(json.dumps({'ok': False, 'reason': 'MISSING_FFMPEG'}))
        return 4
    print(json.dumps({'ok': True, 'numpy': numpy.__version__, 'device': screen_device()}))
    return 0


def cmd_analyze(mov, crop, outdir='/tmp/_flicker_frames'):
    """逐帧判"内容有没有被缩成一小块"。

    两个坑（都实际踩过，直接导致假阴性）：
      1. **不能量"非白像素 bbox"**。编码器在裁剪边缘留下的暗线、窗口圆角透出的桌面，
         会在最后一两行/列撒下几十个暗点，一量就是 100% —— 缩到 24% 的帧照样"通过"。
         所以先切掉外圈 8px，再取 x 坐标的 0.5%–99.5% 分位（几十个杂点撼动不了分位）。
      2. **阈值要 200 而不是 235**。h264 的白色不是纯 254，边缘有噪声，235 会把噪声算成墨。
    """
    try:
        import numpy as np
        from PIL import Image
    except Exception:
        print('MISSING_PIL')
        return 4
    if not shutil.which('ffmpeg'):
        print('MISSING_FFMPEG')
        return 4
    shutil.rmtree(outdir, ignore_errors=True)
    os.makedirs(outdir, exist_ok=True)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', mov,
                    '-vf', f'crop={crop}', f'{outdir}/f%04d.png'], check=False)
    files = sorted(glob.glob(f'{outdir}/f*.png'))
    PAD, THR, P = 8, 200, 0.5
    tiny, inks, cws, diffs = [], [], [], []
    prev = None
    for i, f in enumerate(files):
        a = np.array(Image.open(f).convert('RGB')).astype(np.int16)
        if prev is not None:
            diffs.append(float(np.abs(a - prev).mean()))
        prev = a
        b = a[PAD:-PAD, PAD:-PAD]
        m = b.mean(axis=2) < THR
        inks.append(float(m.mean() * 100))
        if m.sum() < 200:
            continue
        ys, xs = np.where(m)
        lo, hi = np.percentile(xs, P), np.percentile(xs, 100 - P)
        cw = float(hi - lo + 1) / b.shape[1] * 100
        cws.append((i, cw))
        if cw < 60:                     # 正常铺满 ≈ 97–100%；缩成 1/4 ≈ 24%
            tiny.append([i, round(cw, 1)])
    # "画面有没有真的动过"：静态页重复 reload 也可能像素全同，光看 ink 波动会误判成
    # "没拍到窗口"。改用帧间差异 —— 只要有一帧和上一帧明显不同，就说明镜头是活的。
    big = [(i + 1, round(d, 2)) for i, d in enumerate(diffs) if d > 1.0]
    print(json.dumps({
        'frames': len(files),
        'tiny': tiny[:20],
        'tiny_count': len(tiny),
        'cw_min': round(min((c for _, c in cws), default=0), 1),
        'cw_min_frame': (min(cws, key=lambda t: t[1])[0] if cws else None),
        'ink_min': round(min(inks), 2) if inks else None,
        'ink_max': round(max(inks), 2) if inks else None,
        'ink_median': round(float(np.median(inks)), 2) if inks else None,
        'diff_max': round(max(diffs), 2) if diffs else 0,
        'diff_max_frame': (int(np.argmax(diffs)) + 1 if diffs else None),
        'changed_frames': len(big),
    }))
    return 0


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 64
    cmd = sys.argv[1]
    if cmd == 'probe':
        return cmd_probe()
    if cmd == 'record' and len(sys.argv) >= 5:
        geom = None
        if len(sys.argv) >= 6 and sys.argv[5].strip().startswith('{'):
            geom = json.loads(sys.argv[5])
        return cmd_record(int(sys.argv[2]), float(sys.argv[3]), sys.argv[4], geom)
    if cmd == 'analyze' and len(sys.argv) >= 4:
        return cmd_analyze(sys.argv[2], sys.argv[3], *(sys.argv[4:5]))
    print(__doc__)
    return 64


if __name__ == '__main__':
    sys.exit(main())
