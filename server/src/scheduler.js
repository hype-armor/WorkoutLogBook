// The part that actually wakes a phone.
//
// A poll, not a queue. Once a second is plenty for a rest timer, and the whole
// of the state is in the database — so a restart in the middle of a three
// minute rest loses nothing, and there are no in-memory timers to rebuild.
import { sendPush } from './push.js';

export function scheduler({ db, config, send = sendPush, everyMs = 1000 }) {
  let timer = null;
  let running = false;
  const stats = { sent: 0, failed: 0, pruned: 0 };

  /**
   * Claim, then send. The claim is a single statement so that two overlapping
   * ticks — or two schedulers that should not both be running — cannot both
   * take the same row. A send that then fails leaves a row marked sent with
   * nothing delivered, which is the right way round: a second "rest complete"
   * is worse than a missing one, because the timer on screen already went green.
   */
  async function tick(nowMs = Date.now()) {
    if (running || !config.vapidPrivate) return stats;
    running = true;
    try {
      const due = db.prepare(`
        UPDATE alerts SET state = 'sent', sent_at = ?, attempts = attempts + 1
        WHERE id IN (SELECT id FROM alerts
                     WHERE state = 'pending' AND fire_at <= ?
                     ORDER BY fire_at LIMIT 100)
        RETURNING id, sub_id, payload`).all(nowMs, nowMs);
      if (!due.length) return stats;

      const vapid = { publicKey: config.vapidPublic, privateKey: config.vapidPrivate,
                      subject: config.vapidSubject };
      for (const alert of due) {
        const sub = db.prepare('SELECT * FROM push_subs WHERE id = ?').get(alert.sub_id);
        if (!sub) continue;
        try {
          const out = await send(sub, Buffer.from(alert.payload), vapid, { ttl: config.alertTtl });
          if (out.ok) { stats.sent++; continue; }
          if (out.gone) {
            // The browser told us this subscription is finished. It is how we
            // learn someone deleted the app, and the only tidying that matters.
            db.prepare('DELETE FROM push_subs WHERE id = ?').run(sub.id);
            stats.pruned++;
          } else {
            db.prepare('UPDATE push_subs SET fail_count = fail_count + 1 WHERE id = ?').run(sub.id);
            db.prepare("UPDATE alerts SET state = 'failed' WHERE id = ?").run(alert.id);
            stats.failed++;
          }
        } catch (e) {
          db.prepare("UPDATE alerts SET state = 'failed' WHERE id = ?").run(alert.id);
          stats.failed++;
        }
      }
      return stats;
    } finally {
      running = false;
    }
  }

  /** Anything already delivered is history nobody reads. */
  function sweep(nowMs = Date.now()) {
    db.prepare("DELETE FROM alerts WHERE state != 'pending' AND created_at < ?")
      .run(nowMs - 24 * 3600 * 1000);
  }

  return {
    tick,
    sweep,
    stats,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch(e => console.error(JSON.stringify({ at: 'tick_failed', err: String(e) })));
      }, everyMs);
      // Never the reason a process stays alive.
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; }
  };
}
