# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "numpy",
#     "opencv-python-headless",
# ]
# ///

import cv2
import numpy as np

def detect_fingers(image_path, output_path):
    img = cv2.imread(image_path, cv2.IMREAD_UNCHANGED) # 读取包括alpha通道
    if img is None:
        print(f"Error: Could not read image {image_path}")
        return

    # 处理图像，获取二值图
    # 如果有alpha通道（通常emoji是透明背景PNG）
    if img.shape[2] == 4:
        alpha = img[:, :, 3]
        _, thresh = cv2.threshold(alpha, 127, 255, cv2.THRESH_BINARY)
    else:
        # 如果没有alpha，尝试颜色分割
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        lower_yellow = np.array([15, 50, 50])
        upper_yellow = np.array([40, 255, 255])
        mask = cv2.inRange(hsv, lower_yellow, upper_yellow)
        kernel = np.ones((5,5), np.uint8)
        thresh = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

    # 转化为BGR以便绘图 (如果是RGBA转回BGR)
    if img.shape[2] == 4:
        draw_img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
    else:
        draw_img = img.copy()

    # 寻找轮廓
    contours, _ = cv2.findContours(thresh, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    
    if not contours:
        print("No contours found.")
        return

    # 找到最大的轮廓
    max_contour = max(contours, key=cv2.contourArea)
    
    # 1. 寻找并在图上标记凸包顶点，这些通常是手指尖
    hull_indices = cv2.convexHull(max_contour, returnPoints=False)
    hull_points = cv2.convexHull(max_contour, returnPoints=True)
    
    # 2. 也是用缺陷检测来辅助
    defects = cv2.convexityDefects(max_contour, hull_indices)
    
    defect_count = 0
    
    # 绘制最大的轮廓
    cv2.drawContours(draw_img, [max_contour], -1, (0, 255, 0), 2)
    
    if defects is not None:
        for i in range(defects.shape[0]):
            s, e, f, d = defects[i, 0]
            start = tuple(max_contour[s][0])
            end = tuple(max_contour[e][0])
            far = tuple(max_contour[f][0])
            
            # 计算三角形边长
            a = np.sqrt((end[0] - start[0])**2 + (end[1] - start[1])**2)
            b = np.sqrt((far[0] - start[0])**2 + (far[1] - start[1])**2)
            c = np.sqrt((end[0] - far[0])**2 + (end[1] - far[1])**2)
            
            # 余弦定理求角
            angle = np.arccos((b**2 + c**2 - a**2) / (2*b*c)) * 57.2957795
            
            # 手指间的缝隙通常角度较小 (<90)，深度较深
            # d 是距离 * 256
            if angle <= 90 and d > 3000: # 加大深度阈值，避免误判指关节
                defect_count += 1
                cv2.circle(draw_img, far, 8, [0, 0, 255], -1) # 红色点标记凹陷
                
    # 简单的逻辑：手指数量 = 深凹陷数量 + 1
    # 对于标准张开的手掌比较准确
    estimated_fingers = defect_count + 1
    
    # 另外一种思路：尝试直接标记手指尖（凸包点）
    # 为了验证，把所有凸包点画出来看看 (蓝色小点)
    for point in hull_points:
        pt = tuple(point[0])
        # 我们可以根据点相对于质心的位置进一步过滤，这里先全部画出来
        cv2.circle(draw_img, pt, 5, [255, 0, 0], -1)

    cv2.putText(draw_img, f"Est. Fingers: {estimated_fingers}", (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
    
    cv2.imwrite(output_path, draw_img)
    print(f"Detected {estimated_fingers} fingers based on defects. Saved to {output_path}")

detect_fingers("canvas/05-手指计数/原图-手掌emoji.png", "canvas/05-手指计数/attempt_1.png")
