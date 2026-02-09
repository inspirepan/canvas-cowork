import { MultiFileDiff } from "@pierre/diffs/react";

interface DiffViewProps {
  oldText: string;
  newText: string;
  fileName?: string;
}

export function DiffView({ oldText, newText, fileName }: DiffViewProps) {
  const name = fileName ?? "";

  return (
    <MultiFileDiff
      oldFile={{ name, contents: oldText }}
      newFile={{ name, contents: newText }}
      options={{
        diffStyle: "unified",
        themeType: "system",
        overflow: "wrap",
        disableLineNumbers: false,
        disableFileHeader: true,
        expansionLineCount: 10,
        lineDiffType: "word-alt",
      }}
      className="rounded-md overflow-hidden"
      style={
        {
          "--diffs-font-family": "ui-monospace, monospace",
          "--diffs-font-size": "12px",
          "--diffs-line-height": "20px",
          "--diffs-tab-size": 2,
          "--diffs-gap-block": 0,
          "--diffs-min-number-column-width": "4ch",
        } as React.CSSProperties
      }
    />
  );
}
