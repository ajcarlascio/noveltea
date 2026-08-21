import com.noveltea.order.FractionalIndex;
import java.util.*;

/**
 * Emits conformance vectors for the TypeScript port in src/data/order.ts.
 *
 * Deterministic: a fixed seed, so regenerating produces the same file and a diff
 * means the Java changed. Covers the shapes a binder actually produces (appending,
 * prepending, squeezing into one gap) plus a wide randomised walk, because the
 * failure modes worth catching here are arithmetic ones — a misplaced bracket, an
 * off-by-one on a digit index, a rounding rule that differs on ties — and those hide
 * in the cases nobody thought to write down.
 */
public class Gen {
    static List<String> lines = new ArrayList<>();

    static void rec(String label, String a, String b) {
        String out;
        try { out = "\"" + FractionalIndex.between(a, b) + "\""; }
        catch (RuntimeException e) { out = "null"; }
        lines.add("  { \"label\": \"" + label + "\", \"after\": " + q(a) + ", \"before\": " + q(b)
                + ", \"expected\": " + out + " }");
    }

    static String q(String s) { return s == null ? "null" : "\"" + s + "\""; }

    static String safe(String a, String b) {
        try { return FractionalIndex.between(a, b); } catch (RuntimeException e) { return null; }
    }

    public static void main(String[] args) {
        rec("first", null, null);

        String k = null;
        for (int i = 0; i < 20; i++) { rec("append-" + i, k, null); k = FractionalIndex.between(k, null); }

        String p = null;
        for (int i = 0; i < 20; i++) { rec("prepend-" + i, null, p); p = FractionalIndex.between(null, p); }

        // Sixty inserts into the same gap: the case that exhausts IEEE precision in
        // float-based indexing (amendment A4).
        String lo = FractionalIndex.between(null, null);
        String hi = FractionalIndex.between(lo, null);
        for (int i = 0; i < 60; i++) { rec("squeeze-" + i, lo, hi); hi = FractionalIndex.between(lo, hi); }

        // A realistic pool of keys: a long sibling list, with repeated insertions at
        // random positions, exactly as reordering a binder produces.
        Random random = new Random(20260821L);
        List<String> pool = new ArrayList<>();
        String cursor = null;
        for (int i = 0; i < 40; i++) { cursor = FractionalIndex.between(cursor, null); pool.add(cursor); }

        for (int i = 0; i < 400; i++) {
            Collections.sort(pool);
            int at = random.nextInt(pool.size() + 1);
            String before = at == 0 ? null : pool.get(at - 1);
            String after = at == pool.size() ? null : pool.get(at);
            // between(lower, upper) — lower is the one that sorts first.
            String made = safe(before, after);
            rec("walk-" + i, before, after);
            if (made != null) pool.add(made);
        }

        // Every ordered pair from a small sorted sample, including the reversed and
        // equal pairs the algorithm must refuse.
        Collections.sort(pool);
        List<String> sample = new ArrayList<>();
        for (int i = 0; i < pool.size(); i += Math.max(1, pool.size() / 12)) sample.add(pool.get(i));
        for (int i = 0; i < sample.size(); i++) {
            for (int j = 0; j < sample.size(); j++) {
                rec("pair-" + i + "-" + j, sample.get(i), sample.get(j));
            }
        }

        // Open-ended pairs, and the keys ending in '0' that must be refused.
        for (int i = 0; i < sample.size(); i++) {
            rec("open-after-" + i, sample.get(i), null);
            rec("open-before-" + i, null, sample.get(i));
        }
        rec("reject-after-zero", "a0", null);
        rec("reject-before-zero", null, "a0");
        rec("reject-both-zero", "a0", "b0");
        rec("empty-after", "", null);
        rec("empty-after-with-before", "", "V");

        System.out.println("[\n" + String.join(",\n", lines) + "\n]");
    }
}
