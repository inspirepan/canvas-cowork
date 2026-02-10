# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "numpy",
#     "opencv-python-headless",
#     "scipy",
# ]
# ///

import cv2
import numpy as np
from scipy.signal import find_peaks

def detect_fingers_peaks(image_path, output_path):
    img = cv2.imread(image_path, cv2.IMREAD_UNCHANGED)
    if img is None:
        print("Error reading image")
        return

    # 1. 预处理
    if len(img.shape) > 2 and img.shape[2] == 4:
        alpha = img[:, :, 3]
        _, mask = cv2.threshold(alpha, 127, 255, cv2.THRESH_BINARY)
        display_img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
    else:
        if len(img.shape) == 3:
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        else:
            gray = img
        _, mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        if mask[0,0] == 255 and mask[-1,-1] == 255:
             mask = cv2.bitwise_not(mask)
        display_img = img.copy()

    kernel = np.ones((5,5), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        print("No contours found")
        return
    max_cnt = max(contours, key=cv2.contourArea)

    # 2. 找掌心
    dist_transform = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    _, max_dist, _, max_loc = cv2.minMaxLoc(dist_transform)
    cx, cy = max_loc
    palm_radius = max_dist

    # 3. 构建距离曲线
    points = max_cnt[:, 0, :]
    distances = np.linalg.norm(points - np.array([cx, cy]), axis=1)

    # 平滑距离曲线
    window_size = 21 # 稍微大一点的窗口
    kernel = np.ones(window_size) / window_size
    distances_padded = np.pad(distances, (window_size//2, window_size//2), mode='wrap')
    distances_smooth = np.convolve(distances_padded, kernel, mode='valid')

    # 4. 寻找峰值
    # distance: 指尖之间的最小轮廓点距离。假设手指至少占轮廓的 1/20
    min_peak_dist_indices = len(points) / 20 
    
    # height: 必须显著突出
    peaks, _ = find_peaks(distances_smooth, height=palm_radius * 1.4, distance=min_peak_dist_indices)
    
    final_fingers = []
    
    for p_idx in peaks:
        pt = points[p_idx]
        # Y轴过滤：不能在掌心太下方
        # 考虑到某些手势，稍微宽松点，但在掌心圆下方 1.0半径 外肯定不是手指
        if pt[1] < cy + palm_radius:
             final_fingers.append(pt)

    # 如果检测到过多（>5），可能有些是噪音，尝试只保留距离最远的5个
    if len(final_fingers) > 5:
        # 按距离降序
        final_fingers.sort(key=lambda p: np.linalg.norm(p - np.array([cx, cy])), reverse=True)
        final_fingers = final_fingers[:5]

    # 按x坐标排序，从左到右编号
    final_fingers.sort(key=lambda p: p[0])

    # 绘制
    cv2.circle(display_img, (cx, cy), int(palm_radius), (255, 255, 0), 2)
    cv2.circle(display_img, (cx, cy), 5, (0, 0, 255), -1)
    
    for i, pt in enumerate(final_fingers):
        cv2.line(display_img, (cx, cy), tuple(pt), (0, 255, 0), 2)
        cv2.circle(display_img, tuple(pt), 15, (0, 0, 255), -1)
        cv2.putText(display_img, str(i+1), (pt[0]-10, pt[1]-30), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 0, 0), 3)

    count = len(final_fingers)
    label = f"Count: {count}"
    (w, h), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 2, 3)
    cv2.rectangle(display_img, (20, 100-h-10), (20+w, 100+10), (255,255,255), -1)
    cv2.putText(display_img, label, (20, 100), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 255), 3)

    cv2.imwrite(output_path, display_img)
    print(f"Detected {count} fingers with peak detection. Saved to {output_path}")

detect_fingers_peaks("canvas/05-手指计数/原图-手掌emoji.png", "canvas/05-手指计数/final_result.png")
