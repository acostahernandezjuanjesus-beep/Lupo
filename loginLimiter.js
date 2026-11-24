// Limits failed logins per ORIGIN (not per account, or anyone could lock out a victim) and tracks
// the escalating wait per typed username.
//
// In memory on purpose: single process, and a database table would turn every failed attempt into a write.
// Bounded by `cap`: under floods from fake addresses the oldest entries are forgotten first.
//
// An attempt takes its slot BEFORE the password is verified, not after, so a burst of simultaneous
// attempts can't all see a zero counter. A success frees only its own slot.
//
// The escalating wait counts typed usernames whether they exist or not, so response time doesn't reveal accounts.

class LoginLimiter {
    constructor({ max = 10, windowMs = 15 * 60 * 1000, cap = 5000, now = Date.now } = {}) {
        this.max = max;
        this.windowMs = windowMs;
        this.cap = cap;
        this.now = now;
        this.attempts = new Map();        // origin -> [{ t }], oldest first
        this.streaks = new Map();         // typed username -> { n, last }
    }

    #current(origin) {
        const since = this.now() - this.windowMs;
        const list = (this.attempts.get(origin) ?? []).filter(i => i.t > since);
        if (list.length === 0) this.attempts.delete(origin); else this.attempts.set(origin, list);
        return list;
    }

    #bound(map) {
        // Map keeps insertion order, so the first key is the oldest.
        while (map.size > this.cap) map.delete(map.keys().next().value);
    }

    /**
     * Takes a slot for this origin BEFORE verifying anything.
     * -> { allowed: false, wait }  or  { allowed: true, release() }
     * `wait` is in seconds. `release()` gives the slot back (success, or a server error that isn't the caller's fault).
     */
    reserve(origin) {
        const list = this.#current(origin);
        if (list.length >= this.max) {
            // Frees up when the attempt that put it over the cap leaves the window.
            const freesAt = list[list.length - this.max].t + this.windowMs;
            return { allowed: false, wait: Math.max(1, Math.ceil((freesAt - this.now()) / 1000)) };
        }
        const mine = { t: this.now() };
        list.push(mine);
        this.attempts.set(origin, list);
        this.#bound(this.attempts);
        return {
            allowed: true,
            release: () => {
                const current = this.attempts.get(origin);
                if (!current) return;
                const i = current.indexOf(mine);
                if (i >= 0) current.splice(i, 1);
                if (current.length === 0) this.attempts.delete(origin);
            },
        };
    }

    /** Records a failure for this typed username and returns how many in a row it has (existing or not). */
    recordFailure(username) {
        const now = this.now();
        const prev = this.streaks.get(username);
        // No failures for a whole window: start over.
        const n = prev && now - prev.last < this.windowMs ? prev.n + 1 : 1;
        this.streaks.delete(username);               // reinserting makes it the newest
        this.streaks.set(username, { n, last: now });
        this.#bound(this.streaks);
        return n;
    }

    /** A success clears the streak for that username. */
    forget(username) { this.streaks.delete(username); }
}

module.exports = { LoginLimiter };
