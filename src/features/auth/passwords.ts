/**
 * The password rule, stated once on this side of the wire.
 *
 * The server owns the decision — {@code com.noveltea.auth.Passwords} — and re-checks
 * everything sent to it. This copy exists so a typo costs a keystroke rather than a round
 * trip, and it is deliberately the only rule duplicated: length is the whole policy, and
 * composition rules push people towards Password1! and are worth less than four more
 * characters.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;
