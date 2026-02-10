# /// script
# requires-python = ">=3.8"
# dependencies = [
#    "pillow",
# ]
# ///
from PIL import Image, ImageDraw

def refine_annotation(input_path, output_path):
    img = Image.open(input_path).convert("RGB")
    draw = ImageDraw.Draw(img)
    
    # 重新观察指尖位置（x, y）
    # 7根手指是显而易见的，但有些位置可能需要微调
    fingers = [
        (65, 225),  # 1: 左侧
        (98, 131),  # 2: 左上
        (171, 84),  # 3: 顶部中
        (243, 103), # 4: 右上
        (294, 161), # 5: 右侧
        (303, 235), # 6: 右下
        (265, 298)  # 7: 最下方
    ]
    
    for i, (x, y) in enumerate(fingers):
        # 绘制更醒目的标记
        r = 8
        draw.ellipse((x-r, y-r, x+r, y+r), fill=(255, 0, 0), outline=(255, 255, 255), width=2)
        # 编号
        draw.text((x + 12, y - 12), f"FINGER {i + 1}", fill=(255, 255, 0))
        
    img.save(output_path)
    print(f"Refined annotation saved to {output_path}")

if __name__ == "__main__":
    refine_annotation("canvas/image-0210-205335-1.png", "canvas/refined_fingers.png")
