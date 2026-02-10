# /// script
# requires-python = ">=3.8"
# dependencies = [
#    "pillow",
# ]
# ///
from PIL import Image, ImageDraw, ImageFont

def annotate_image(input_path, output_path):
    img = Image.open(input_path).convert("RGB")
    draw = ImageDraw.Draw(img)
    
    # Estimated fingertip coordinates (x, y)
    fingers = [
        (65, 235),  # 1: Leftmost
        (100, 135), # 2
        (170, 85),  # 3
        (245, 105), # 4
        (295, 165), # 5
        (300, 235), # 6
        (265, 290)  # 7
    ]
    
    for i, (x, y) in enumerate(fingers):
        # Draw a small circle
        r = 5
        draw.ellipse((x-r, y-r, x+r, y+r), fill="red", outline="white")
        # Draw the number
        draw.text((x + 10, y - 10), str(i + 1), fill="yellow")
        
    img.save(output_path)
    print(f"Annotated image saved to {output_path}")
    print(f"Total fingers counted: {len(fingers)}")

if __name__ == "__main__":
    annotate_image("canvas/image-0210-205335-1.png", "canvas/annotated_fingers.png")
