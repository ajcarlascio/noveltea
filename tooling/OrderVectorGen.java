import com.noveltea.order.FractionalIndex;
import java.util.*;

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

    public static void main(String[] args) {
        rec("first", null, null);

        // Appending to the end, twenty times.
        String k = null;
        for (int i = 0; i < 20; i++) { rec("append-" + i, k, null); k = FractionalIndex.between(k, null); }

        // Prepending to the front, twenty times.
        String p = null;
        for (int i = 0; i < 20; i++) { rec("prepend-" + i, null, p); p = FractionalIndex.between(null, p); }

        // Sixty inserts between the same two siblings. This is the case that exhausts
        // IEEE double precision in float-based indexing (amendment A4).
        String lo = FractionalIndex.between(null, null);
        String hi = FractionalIndex.between(lo, null);
        for (int i = 0; i < 60; i++) { rec("squeeze-" + i, lo, hi); hi = FractionalIndex.between(lo, hi); }

        // Rejections.
        rec("reject-equal", "a1", "a1");
        rec("reject-reversed", "a2", "a1");
        rec("reject-after-zero", "a0", null);
        rec("reject-before-zero", null, "a0");

        System.out.println("[\n" + String.join(",\n", lines) + "\n]");
    }
}
