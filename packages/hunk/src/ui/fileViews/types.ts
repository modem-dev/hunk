/** Identify one host-rendered file-presentation row failure for warning attribution. */
export interface FileViewRowFailure {
  extensionId: string;
  viewId: string;
  fileId: string;
  filePath: string;
  rowId: string;
  layoutGeneration: number;
  message: string;
}
