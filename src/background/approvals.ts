import type { ApprovalRequest, ApprovalResult, ApprovalType, Approver } from '../core/dapp/types';

const APPROVAL_TIMEOUT_MS = 10 * 60_000;

interface Pending {
  request: ApprovalRequest;
  resolve: (r: ApprovalResult) => void;
}

/**
 * Queues dApp approval requests and shows them in a dedicated popup window.
 * The window renders the oldest pending request; closing it rejects everything queued.
 */
export class ChromeApprover implements Approver {
  private queue: Pending[] = [];
  private windowId?: number;
  /** In-flight window creation, so simultaneous requests share one window. */
  private opening?: Promise<void>;

  constructor(private onQueueChange: (count: number) => void = () => {}) {
    chrome.windows.onRemoved.addListener((id) => {
      if (id !== this.windowId) return;
      this.windowId = undefined;
      for (const p of this.queue.splice(0)) p.resolve({ approved: false });
      this.onQueueChange(0);
    });
  }

  request(type: ApprovalType, origin: string, payload: Record<string, unknown>): Promise<ApprovalResult> {
    return new Promise((resolve) => {
      const request: ApprovalRequest = { id: crypto.randomUUID(), type, origin, payload, createdAt: Date.now() };
      this.queue.push({ request, resolve });
      // Don't let a forgotten request hang the dApp forever.
      setTimeout(() => this.resolve(request.id, { approved: false }), APPROVAL_TIMEOUT_MS);
      this.onQueueChange(this.queue.length);
      this.opening ??= this.showWindow().finally(() => (this.opening = undefined));
    });
  }

  list(): ApprovalRequest[] {
    return this.queue.map((p) => p.request);
  }

  resolve(id: string, result: ApprovalResult) {
    const idx = this.queue.findIndex((p) => p.request.id === id);
    if (idx < 0) return;
    const [p] = this.queue.splice(idx, 1);
    p.resolve(result);
    this.onQueueChange(this.queue.length);
    if (!this.queue.length && this.windowId !== undefined) {
      const id = this.windowId;
      this.windowId = undefined;
      chrome.windows.remove(id).catch(() => {});
    }
  }

  private async showWindow() {
    if (this.windowId !== undefined) {
      try {
        await chrome.windows.update(this.windowId, { focused: true });
        return;
      } catch {
        this.windowId = undefined;
      }
    }
    const width = 380;
    const height = 640;
    let left: number | undefined;
    let top: number | undefined;
    try {
      const current = await chrome.windows.getLastFocused();
      if (current.left !== undefined && current.width !== undefined) left = current.left + current.width - width - 16;
      if (current.top !== undefined) top = current.top + 64;
    } catch {
      // Positioning is best-effort.
    }
    const opts: chrome.windows.CreateData = {
      url: chrome.runtime.getURL('popup.html#/approve'),
      type: 'popup',
      width,
      height,
      focused: true,
    };
    try {
      this.windowId = (await chrome.windows.create({ ...opts, left, top }))?.id;
    } catch {
      // Chrome rejects bounds that fall mostly off-screen (e.g. multi-monitor setups); let it place the window.
      try {
        this.windowId = (await chrome.windows.create(opts))?.id;
      } catch (e) {
        // Requests stay queued; opening the toolbar popup shows them.
        console.warn('Could not open approval window', e);
      }
    }
  }
}
