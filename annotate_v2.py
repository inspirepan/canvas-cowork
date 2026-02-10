# /// script
# requires-python = ">=3.8"
# dependencies = [
#    "Pillow",
# ]
# ///
from PIL import Image, ImageDraw

img = Image.open("canvas/05-手指计数/原图-手掌emoji.png").convert("RGB")
draw = ImageDraw.Draw(img)

# Refined coordinates for 353x353 Apple-style hand emoji
points = [
    (65, 205),   # Thumb
    (115, 87),   # Index
    (176, 72),   # Middle
    (238, 93),   # Ring
    (288, 145)   # Pinky
]

for i, (x, y) in enumerate(points):
    r = 12
    draw.ellipse([x-r, y-r, x+r, y+r], outline="red", width=3)
    draw.text((x-4, y-8), str(i+1), fill="red")

img.save("canvas/05-手指计数/标注-v2.png")
print("Saved canvas/05-手指计数/标注-v2.png")
