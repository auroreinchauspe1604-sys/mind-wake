/** This is one explicit local pilot, not an HTML trust registry. The native reader
 * must also attest the launch-time opt-in before any script-enabled frame exists.
 */
export const ATELIER_DOCUMENT = 'artifacts/creations/atelier-dj/index.html';
export const ATELIER_URL = 'http://127.0.0.1:8941/';
export const ATELIER_SANDBOX = 'allow-scripts allow-same-origin allow-downloads';

export function atelierUrl(scope: string, relative: string, descriptor: unknown): string | null {
  if (scope !== 'agent' || relative !== ATELIER_DOCUMENT || !descriptor || typeof descriptor !== 'object') return null;
  const app = descriptor as Record<string, unknown>;
  return app['id'] === 'atelier-dj' && app['url'] === ATELIER_URL ? ATELIER_URL : null;
}

/** Separate browsing context: never relax the document reader's srcdoc sandbox.
 * No message listener/IPC bridge, top navigation, forms, popups or remote origin grants.
 */
export function createAtelierFrame(): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  frame.id = 'local-atelier-frame';
  frame.title = 'Atelier DJ · application locale interactive';
  frame.setAttribute('sandbox', ATELIER_SANDBOX);
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; autoplay 'none'");
  frame.hidden = true;
  return frame;
}
