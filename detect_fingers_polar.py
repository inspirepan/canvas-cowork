# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "numpy",
#     "opencv-python-headless",
# ]
# ///

import cv2
import numpy as np
import math

def detect_fingers_polar(image_path, output_path):
    img = cv2.imread(image_path, cv2.IMREAD_UNCHANGED)
    if img is None:
        return

    if len(img.shape) > 2 and img.shape[2] == 4:
        alpha = img[:, :, 3]
        _, mask = cv2.threshold(alpha, 127, 255, cv2.THRESH_BINARY)
        display_img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
    else:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        _, mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        if mask[0,0] == 255 and mask[-1,-1] == 255:
             mask = cv2.bitwise_not(mask)
        display_img = img.copy()

    kernel = np.ones((5,5), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return
    max_cnt = max(contours, key=cv2.contourArea)

    # 2. 找掌心
    dist_transform = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    _, max_dist, _, max_loc = cv2.minMaxLoc(dist_transform)
    cx, cy = max_loc
    palm_radius = max_dist

    # 3. 提取指尖候选点
    hull = cv2.convexHull(max_cnt, returnPoints=True)
    if hull is None:
        return

    points = [pt[0] for pt in hull]
    
    candidates = []
    distance_threshold = palm_radius * 1.5
    
    for pt in points:
        dist = np.linalg.norm(np.array(pt) - np.array([cx, cy]))
        if dist > distance_threshold:
            # y轴筛选：不能比掌心低 (稍微严格一点)
            # 大拇指可能和掌心平行，所以允许一点点误差
            if pt[1] < cy + palm_radius * 0.5: 
                angle = math.atan2(pt[1] - cy, pt[0] - cx)
                candidates.append({'pt': pt, 'angle': angle, 'dist': dist})
    
    # 4. 基于角度聚类
    candidates.sort(key=lambda x: x['angle'])
    
    merged_fingers = []
    if candidates:
        current_cluster = [candidates[0]]
        # 增大角度阈值：手指间距通常较大，同一指尖的点角度很近
        # 我们希望把同一个指尖上的多个凸点合并，但不能合并两个手指
        # 手指间距大约是 15-30度？
        # 同一个指尖上的点通常在 5-10度以内。
        # 让我们设为 18度 (约 0.3 radians)
        angle_thresh = 0.3 
        
        for i in range(1, len(candidates)):
            diff = candidates[i]['angle'] - candidates[i-1]['angle']
            
            # 处理跨越 +/- pi 的情况（虽然在这个 emoji 图中手指朝上，不太会遇到）
            if diff < -math.pi: diff += 2*math.pi
            if diff > math.pi: diff -= 2*math.pi
            diff = abs(diff)

            if diff < angle_thresh:
                current_cluster.append(candidates[i])
            else:
                best_pt = max(current_cluster, key=lambda x: x['dist'])
                merged_fingers.append(best_pt)
                current_cluster = [candidates[i]]
        
        if current_cluster:
            best_pt = max(current_cluster, key=lambda x: x['dist'])
            merged_fingers.append(best_pt)

    # 可视化
    cv2.circle(display_img, (cx, cy), int(palm_radius), (255, 0, 0), 2)
    cv2.circle(display_img, (cx, cy), 5, (255, 0, 0), -1)

    for i, finger in enumerate(merged_fingers):
        pt = tuple(finger['pt'])
        cv2.line(display_img, (cx, cy), pt, (0, 255, 0), 2)
        cv2.circle(display_img, pt, 10, (0, 0, 255), -1)
        cv2.putText(display_img, str(i+1), (pt[0]-10, pt[1]-20), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 0, 0), 2)

    count = len(merged_fingers)
    cv2.putText(display_img, f"Count: {count}", (20, 100), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 255), 3)

    cv2.imwrite(output_path, display_img)
    print(f"Detected {count} fingers with polar clustering. Saved to {output_path}")

detect_fingers_polar("canvas/05-手指计数/原图-手掌emoji.png", "canvas/05-手指计数/attempt_3.png")
