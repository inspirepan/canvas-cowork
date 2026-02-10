# /// script
# requires-python = ">=3.8"
# dependencies = [
#    "Pillow",
# ]
# ///
from PIL import Image, ImageDraw, ImageFont

img = Image.open("canvas/05-手指计数/原图-手掌emoji.png").convert("RGB")
draw = ImageDraw.Draw(img)

# Initial guesses for a 353x353 hand emoji (facing forward, fingers up)
# Thumb is likely separate, others are lined up.
points = [
    (80, 210),  # Thumb
    (115, 120),  # Index
    (178, 85),  # Middle
    (240, 120), # Ring
    (275, 210)  # Pinky - wait, emoji pinky is usually higher or lower?
]

for i, (x, y) in enumerate(points):
    radius = 10
    draw.ellipse([x-radius, y-radius, x+radius, y+radius], fill="red", outline="white")
    draw.text((x+15, y), str(i+1), fill="red")

img.save("canvas/05-手指计数/标注-v1.png")
print("Saved canvas/05-手指计数/标注-v1.png")
