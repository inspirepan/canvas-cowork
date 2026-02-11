# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pillow",
# ]
# ///
import PIL.Image
import PIL.ImageDraw
import PIL.ImageFont

img = PIL.Image.open("canvas/05-手指计数/原图-手掌emoji.png").convert("RGB")
draw = PIL.ImageDraw.Draw(img)

# v1: Marks for 5 fingers
# 1. Thumb (left): ~ (70, 200)
# 2. Index: ~ (110, 80)
# 3. Middle: ~ (175, 50)
# 4. Ring: ~ (245, 80)
# 5. Pinky: ~ (290, 160)

points = [
    (70, 205),  # 拇指
    (110, 85),  # 食指
    (178, 55),  # 中指
    (245, 85),  # 无名指
    (290, 160)  # 小指
]

for i, p in enumerate(points):
    r = 10
    draw.ellipse([p[0]-r, p[1]-r, p[0]+r, p[1]+r], fill="red", outline="white")
    draw.text((p[0]+12, p[1]-10), str(i+1), fill="red")

img.save("canvas/05-手指计数/标注-v1-test.png")
print("Saved v1")
