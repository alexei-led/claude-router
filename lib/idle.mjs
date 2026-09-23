// When the gateway may exit on its own. Claude Code holds no connection open between requests, so an idle session
// and a closed one look the same here: the signal is time without requests. Two cases must still keep the gateway:
// a request in flight, and a turn that waits for a tool result (a permission prompt or a question nobody answered
// yet), whose next request comes without a prompt and so without the hook that would start a gateway again.
// A session killed mid-turn stops counting after TURN_WAIT_MS.
export const TURN_WAIT_MS = 24 * 3_600_000;

export class IdleTracker {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.inFlight = 0;
    this.lastActive = now();
    this.waiting = new Map(); // session -> when its last response asked for a tool
  }

  requestStarted() {
    this.inFlight += 1;
    this.lastActive = this.now();
  }

  requestEnded() {
    this.inFlight -= 1;
    this.lastActive = this.now();
  }

  // A Messages request for the session: whatever it waited for has arrived.
  turnResumed(session) {
    this.waiting.delete(session);
  }

  turnPaused(session) {
    this.waiting.set(session, this.now());
  }

  idle(idleMs) {
    const now = this.now();
    if (this.inFlight > 0 || now - this.lastActive < idleMs) return false;
    for (const [session, at] of this.waiting) if (now - at >= TURN_WAIT_MS) this.waiting.delete(session);
    return this.waiting.size === 0;
  }
}
