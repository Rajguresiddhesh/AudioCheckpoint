/** One-shot launch messages (e.g. "tracking restarted after interruption") shown on Home. */
let notice: string | null = null;

export function setLaunchNotice(text: string | null): void {
  notice = text;
}

export function takeLaunchNotice(): string | null {
  const n = notice;
  notice = null;
  return n;
}
