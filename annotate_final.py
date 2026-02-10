# /// script
# requires-python = ">=3.8"
# dependencies = [
#    "Pillow",
# ]
# ///
from PIL import Image, ImageDraw

img = Image.open("canvas/05-手指计数/原图-手掌emoji.png").convert("RGB")
draw = ImageDraw.Draw(img)

# Standard positions for 353x353 hand emoji
# Thumb, Index, Middle, Ring, Pinky
points = [
    (67, 198),   # 1. 拇指
    (115, 87),   # 2. 食指
    (178, 68),   # 3. 中指
    (240, 93),   # 4. 无名指
    (290, 142)   # 5. 小拇指
]

for i, (x, y) in enumerate(points):
    # Draw a circle
    r = 15
    draw.ellipse([x-r, y-r, x+r, y+r], outline="blue", width=4)
    # Label
    draw.text((x-5, y-8), str(i+1), fill="blue")

img.save("canvas/05-手指计数/最终标注.png")
print("Saved canvas/05-手指计数/最终标注.png")
