# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "numpy",
#     "opencv-python-headless",
# ]
# ///

import cv2
import numpy as np

def detect_fingers_robust(image_path, output_path):
    img = cv2.imread(image_path, cv2.IMREAD_UNCHANGED)
    if img is None:
        return

    if len(img.shape) > 2 and img.shape[2] == 4:
        alpha = img[:, :, 3]
        _, mask = cv2.threshold(alpha, 127, 255, cv2.THRESH_BINARY)
        display_img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
    else:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        # 用Otsu自动阈值，并反转（假设前景黑背景白？如果不确定，可以检查角点颜色）
        # 这里假设常规图片，前景亮
        _, mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        # 如果四个角都是白的，说明背景是白，需要反转
        if mask[0,0] == 255 and mask[-1,-1] == 255:
             mask = cv2.bitwise_not(mask)
        display_img = img.copy()

    kernel = np.ones((5,5), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return
    max_cnt = max(contours, key=cv2.contourArea)

    # 3. 寻找掌心
    dist_transform = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    _, max_dist, _, max_loc = cv2.minMaxLoc(dist_transform)
    palm_center = max_loc
    
    # 4. 寻找凸包
    hull_points = cv2.convexHull(max_cnt, returnPoints=True)
    
    finger_tips = []
    
    if hull_points is not None:
        # 将凸包点转为 [(x,y), ...]
        points = [pt[0] for pt in hull_points]
        
        # 排序：按照y坐标从小到大（从上到下）
        points.sort(key=lambda p: p[1])
        
        filtered_points = []
        # 动态聚类距离：设为手掌半径的0.3倍
        min_distance_between_fingers = max_dist * 0.5 
        
        for pt in points:
            dist_to_center = np.linalg.norm(np.array(pt) - np.array(palm_center))
            
            # 手指特征：
            # 1. 距离掌心足够远 (大于1.2倍内切圆半径)
            # 2. y坐标不能比掌心低太多 (防止选中手腕两侧)
            #    对于竖起的手掌，手指都在掌心上方(y更小)。
            #    大拇指可能和掌心平行。
            #    我们可以限制 y < palm_center[y] + padding
            
            if dist_to_center > max_dist * 1.2: 
                # y轴限制：点不能在掌心之下太远 (允许一点点大拇指的偏移)
                if pt[1] < palm_center[1] + (max_dist * 0.5):
                    # 检查是否与已有点重复 (欧氏距离)
                    is_new_finger = True
                    for fp in filtered_points:
                        if np.linalg.norm(np.array(pt) - np.array(fp)) < min_distance_between_fingers:
                            is_new_finger = False
                            break
                    if is_new_finger:
                        filtered_points.append(pt)
        
        finger_tips = filtered_points

    # 绘制
    # 画掌心区域
    cv2.circle(display_img, palm_center, int(max_dist), (200, 200, 0), 1)
    
    for i, pt in enumerate(finger_tips):
        cv2.line(display_img, palm_center, tuple(pt), (0, 255, 0), 2)
        cv2.circle(display_img, tuple(pt), 15, (0, 0, 255), -1)
        # 在指尖旁边标号
        cv2.putText(display_img, str(i+1), (pt[0]-10, pt[1]-20), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 0, 0), 2)
        
    count = len(finger_tips)
    cv2.putText(display_img, f"Count: {count}", (20, 100), cv2.FONT_HERSHEY_SIMPLEX, 3, (0, 0, 255), 4)

    cv2.imwrite(output_path, display_img)
    print(f"Detected {count} fingers. Saved to {output_path}")

detect_fingers_robust("canvas/05-手指计数/原图-手掌emoji.png", "canvas/05-手指计数/attempt_2.png")
