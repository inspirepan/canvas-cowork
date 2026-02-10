# /// script
# requires-python = ">=3.8"
# dependencies = [
#    "Pillow",
# ]
# ///
from PIL import Image

img = Image.open("canvas/05-手指计数/原图-手掌emoji.png")
print(f"Size: {img.size}")
