// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import {
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
} from "lucide-react";
import { fileKind } from "./fileMeta";

interface FileTypeIconProps {
  extension: string;
  className?: string;
}

export const FileTypeIcon: React.FC<FileTypeIconProps> = ({
  extension,
  className = "h-4 w-4",
}) => {
  const kind = fileKind(extension);
  const common = { className, "aria-hidden": true } as const;
  switch (kind) {
    case "text":
      return <FileText {...common} />;
    case "image":
      return <FileImage {...common} />;
    case "sheet":
      return <FileSpreadsheet {...common} />;
    case "archive":
      return <FileArchive {...common} />;
    case "audio":
      return <FileAudio {...common} />;
    case "video":
      return <FileVideo {...common} />;
    default:
      return <File {...common} />;
  }
};
