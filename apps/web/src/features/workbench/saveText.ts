/** Save `text` as a file called `name`: a temporary link to a Blob, clicked, then released. */
export function saveText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // the browser reads the Blob when the download starts: release it a moment later
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
