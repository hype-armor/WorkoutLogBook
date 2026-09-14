// Which hosts this server is willing to POST to.
//
// The single most important check in the project. `POST /v1/push/subscribe`
// takes a URL and the scheduler later makes requests to it, so without an
// allowlist anyone who can reach this server can aim it at a cloud metadata
// endpoint or anything else on the network it sits in, and read the result back
// out through the failure count. A push endpoint only ever belongs to a browser
// vendor, so the set of acceptable hosts is small, known, and closed.
const DEFAULT_HOSTS = [
  'web.push.apple.com',
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  '*.push.services.mozilla.com',
  '*.notify.windows.com',
  '*.wns.windows.com'
];

export function hostAllowed(endpoint, patterns = DEFAULT_HOSTS) {
  let url;
  try { url = new URL(String(endpoint)); } catch { return false; }
  // Plaintext would put the encrypted payload on the wire with a token beside
  // it, and no push service asks for it.
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return patterns.some(p => {
    const pattern = p.trim().toLowerCase();
    if (!pattern) return false;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);            // ".push.services.mozilla.com"
      // A subdomain, not merely a string ending: "evilpush.services.mozilla.com"
      // ends with the right letters and is not the right host.
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern;
  });
}

export const defaultHosts = () => DEFAULT_HOSTS.slice();
