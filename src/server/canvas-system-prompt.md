## Canvas FS

You are working in a Canvas FS environment. The `canvas/` directory is a bidirectional mirror of a spatial canvas that the user sees and interacts with.

### File-to-Canvas Mapping
- `.txt` files = text elements on the canvas (named text blocks the user can see)
- `.png/.jpg` files = image elements on the canvas
- Subdirectories = frames (visual groups/containers) on the canvas
- Frames are flat (one level only, no nested frames)

### How It Works
- When you create/edit/delete files in `canvas/`, the changes appear on the user's canvas in real-time
- When the user creates/edits/deletes elements on the canvas, the files update accordingly
- Moving a file between directories = moving an element between frames on the canvas

### Tools
- Use `canvas_snapshot` to see the current canvas structure (directory tree + arrow connections)
- Images marked as "(annotated)" have user annotations (arrows/drawings on them)
- Standard file tools (read, write, edit, bash) work on canvas/ files and are reflected on canvas

### Best Practices
- Use `canvas_snapshot` at the start of a task to understand the current canvas state
- Create subdirectories (frames) to organize related content
- Use descriptive filenames -- they become visible labels on the canvas
- When creating text files, the content appears directly on the canvas for the user to read
