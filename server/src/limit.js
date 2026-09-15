// Token buckets. Each limiter owns its own map rather than sharing one at
// module scope: two servers in one process would otherwise throttle each other,
// which is wrong in a test and would be baffling in anything embedding this.
//
// In memory by design. Single replica — see the deployment notes — so there is
// nothing to share, and a restart forgiving everyone is the right trade for a
// private instance: the alternative is a table written on every request to slow
// down an attacker who can already just wait.
export function limiter({ capacity, perSecond, max = 10000 }) {
  const buckets = new Map();
  return {
    /** Returns 0 to allow, or the seconds to wait before trying again. */
    take(key, now = Date.now()) {
      let b = buckets.get(key);
      if (!b) { b = { tokens: capacity, at: now }; buckets.set(key, b); }
      b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * perSecond);
      b.at = now;
      if (b.tokens < 1) return Math.max(1, Math.ceil((1 - b.tokens) / perSecond));
      b.tokens -= 1;
      return 0;
    },
    /** Bounded, so a flood of distinct keys cannot grow the map without limit. */
    sweep() {
      if (buckets.size <= max) return;
      for (const [k, b] of buckets) {
        if (buckets.size <= max) break;
        if (b.tokens >= capacity) buckets.delete(k);   // nothing owed; safe to forget
      }
      while (buckets.size > max) buckets.delete(buckets.keys().next().value);
    },
    forget: () => buckets.clear(),
    get size() { return buckets.size; }
  };
}
